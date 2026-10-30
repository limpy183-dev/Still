//! Client for the Still Guard named pipe, with the original's history-revision cache
//! (`app/guard-client.cjs` plus the `guard()` request function of `main.cjs`).
use futures_util::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use serde_json::{Map, Value, json};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::ClientOptions,
    time::{sleep, timeout},
};

const PIPE: &str = r"\\.\pipe\Still.Focus.Guard.v1";
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PIPE_BUSY: i32 = 231;

#[derive(Clone, Debug)]
pub struct GuardError {
    pub message: String,
    /// The service is simply not running (the original's ENOENT / ECONNREFUSED).
    pub offline: bool,
}

impl GuardError {
    fn new(message: impl Into<String>) -> Self {
        GuardError { message: message.into(), offline: false }
    }
}

/// Sends one request and reads one reply line. Only the connection phase is retried, because a submitted
/// session request must never be replayed.
pub async fn request_on(pipe: &str, request: &Value, limit: Duration) -> Result<Value, GuardError> {
    let mut attempt = 0;
    let mut pipe = loop {
        match ClientOptions::new().open(pipe) {
            Ok(pipe) => break pipe,
            // Status polling can briefly occupy the pipe while the service creates its next listener.
            Err(e) if matches!(e.raw_os_error(), Some(ERROR_FILE_NOT_FOUND | ERROR_PIPE_BUSY)) && attempt < 10 => {
                attempt += 1;
                sleep(Duration::from_millis(100)).await;
            }
            Err(e) => return Err(GuardError { message: e.to_string(), offline: e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) }),
        }
    };
    let exchange = async {
        pipe.write_all(format!("{request}\n").as_bytes()).await.map_err(|e| GuardError::new(e.to_string()))?;
        let mut data = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = pipe.read(&mut chunk).await.map_err(|e| GuardError::new(e.to_string()))?;
            if read == 0 {
                return Err(GuardError::new("Windows protection disconnected."));
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() > 1024 * 1024 {
                return Err(GuardError::new("Invalid protection response."));
            }
            if let Some(end) = data.iter().position(|b| *b == b'\n') {
                let result: Value = serde_json::from_slice(&data[..end]).map_err(|e| GuardError::new(e.to_string()))?;
                return match result.get("ok") == Some(&Value::Bool(false)) {
                    true => Err(GuardError::new(result["error"].as_str().unwrap_or("Windows protection reported an error."))),
                    false => Ok(result),
                };
            }
        }
    };
    timeout(limit, exchange).await.unwrap_or_else(|_| Err(GuardError::new("Windows protection is not responding. Check the service in Settings.")))
}

type Pending = Shared<LocalBoxFuture<'static, Result<Value, GuardError>>>;

/// Caches history only; every read still asks the service for live session state.
pub struct GuardClient {
    pipe: String,
    history: RefCell<Option<Value>>,
    revision: RefCell<Option<Value>>,
    pending: RefCell<Option<(u64, Pending)>>,
    generation: Cell<u64>,
    mutations: Cell<u32>,
    serial: Cell<u64>,
}

impl Default for GuardClient {
    fn default() -> Self {
        GuardClient::on(PIPE)
    }
}

impl GuardClient {
    /// A client for the guard pipe called `pipe` (tests use their own pipe).
    pub fn on(pipe: &str) -> GuardClient {
        GuardClient { pipe: pipe.to_string(), history: Default::default(), revision: Default::default(), pending: Default::default(), generation: Default::default(), mutations: Default::default(), serial: Default::default() }
    }

    pub fn generation(&self) -> u64 {
        self.generation.get()
    }

    pub fn invalidate(&self) {
        self.generation.set(self.generation.get() + 1);
        *self.pending.borrow_mut() = None;
        *self.history.borrow_mut() = None;
        *self.revision.borrow_mut() = None;
    }

    /// Live status. Concurrent reads share one request unless a mutation is in flight.
    pub fn status(self: &Rc<Self>, full: bool) -> Pending {
        if !full && self.mutations.get() == 0 {
            if let Some((_, pending)) = self.pending.borrow().as_ref() {
                return pending.clone();
            }
        }
        let epoch = self.generation.get();
        let cached = self.history.borrow().clone();
        let mut query = json!({ "command": "status" });
        if !full {
            if let (Some(revision), Some(_)) = (self.revision.borrow().as_ref(), cached.as_ref()) {
                query["historyRevision"] = revision.clone();
            }
        }
        let id = self.serial.get() + 1;
        self.serial.set(id);
        let this = self.clone();
        let pipe = self.pipe.clone();
        let future: Pending = async move {
            let outcome = request_on(&pipe, &query, Duration::from_millis(3500)).await.and_then(|value| {
                let history = value.get("history").filter(|h| !h.is_null()).cloned().or(cached);
                match history {
                    Some(records @ Value::Array(_)) => {
                        if epoch == this.generation.get() {
                            *this.history.borrow_mut() = Some(records.clone());
                            *this.revision.borrow_mut() = value.get("historyRevision").cloned();
                        }
                        let mut merged: Map<String, Value> = value.as_object().cloned().unwrap_or_default();
                        merged.insert("history".into(), records);
                        Ok(Value::Object(merged))
                    }
                    _ => Err(GuardError::new("Invalid protection history response.")),
                }
            });
            if outcome.is_err() && epoch == this.generation.get() {
                this.invalidate();
            }
            if this.pending.borrow().as_ref().is_some_and(|(pending_id, _)| *pending_id == id) {
                *this.pending.borrow_mut() = None;
            }
            outcome
        }
        .boxed_local()
        .shared();
        if !full && self.mutations.get() == 0 {
            *self.pending.borrow_mut() = Some((id, future.clone()));
        }
        future
    }

    /// A command that changes state: fences cached reads before and after, even if the reply is lost.
    pub async fn mutate(self: &Rc<Self>, value: Value) -> Result<Value, GuardError> {
        self.invalidate();
        self.mutations.set(self.mutations.get() + 1);
        let result = request_on(&self.pipe, &value, Duration::from_secs(120)).await;
        self.mutations.set(self.mutations.get() - 1);
        self.invalidate();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::windows::named_pipe::ServerOptions,
        sync::{mpsc, oneshot},
        task::{LocalSet, spawn_local},
    };

    type Held = (Value, oneshot::Sender<Option<Value>>);

    /// A pretend guard: every request is handed to the test, which decides the reply (or a disconnect).
    fn fake_guard(name: &str) -> mpsc::UnboundedReceiver<Held> {
        let (tx, rx) = mpsc::unbounded_channel::<Held>();
        let name = name.to_string();
        spawn_local(async move {
            let mut server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
            loop {
                if server.connect().await.is_err() {
                    return;
                }
                let mut connection = std::mem::replace(&mut server, ServerOptions::new().create(&name).unwrap());
                let tx = tx.clone();
                spawn_local(async move {
                    let mut line = String::new();
                    if BufReader::new(&mut connection).read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let (reply, wait) = oneshot::channel();
                    let _ = tx.send((serde_json::from_str(&line).unwrap(), reply));
                    if let Ok(Some(value)) = wait.await {
                        let _ = connection.write_all(format!("{value}\n").as_bytes()).await;
                    }
                });
            }
        });
        rx
    }

    fn pipe_name() -> String {
        format!(r"\\.\pipe\Still.Test.{}", uuid::Uuid::new_v4())
    }

    /// Answers each request with whatever `reply` holds at that moment, recording the requests.
    fn answer(mut guard: mpsc::UnboundedReceiver<Held>, reply: Rc<std::cell::RefCell<Option<Value>>>, seen: Rc<std::cell::RefCell<Vec<Value>>>) {
        spawn_local(async move {
            while let Some((request, tx)) = guard.recv().await {
                seen.borrow_mut().push(request);
                let _ = tx.send(reply.borrow().clone());
            }
        });
    }

    #[tokio::test]
    async fn history_revisions_retain_snapshots_reset_on_restart_and_support_old_guards() {
        LocalSet::new()
            .run_until(async {
                let name = pipe_name();
                let (reply, seen) = (Rc::new(std::cell::RefCell::new(Some(json!({ "history": [{ "id": "one" }], "historyRevision": "instance-one", "session": null })))), Rc::new(std::cell::RefCell::new(Vec::new())));
                answer(fake_guard(&name), reply.clone(), seen.clone());
                let client = Rc::new(GuardClient::on(&name));
                client.status(false).await.unwrap();
                assert!(seen.borrow().last().unwrap().get("historyRevision").is_none());
                *reply.borrow_mut() = Some(json!({ "historyRevision": "instance-one", "session": { "unlockAt": 500 } }));
                assert_eq!(client.status(false).await.unwrap()["history"], json!([{ "id": "one" }]));
                assert_eq!(seen.borrow().last().unwrap()["historyRevision"], "instance-one");
                assert_eq!(client.status(false).await.unwrap()["session"]["unlockAt"], 500);
                *reply.borrow_mut() = Some(json!({ "history": [{ "id": "two" }], "historyRevision": "instance-two" }));
                assert_eq!(client.status(false).await.unwrap()["history"][0]["id"], "two");
                client.status(true).await.unwrap();
                assert!(seen.borrow().last().unwrap().get("historyRevision").is_none(), "exports and bootstrap force snapshots");
                *reply.borrow_mut() = None;
                assert!(client.status(false).await.is_err());
                *reply.borrow_mut() = Some(json!({ "history": [] }));
                client.status(false).await.unwrap();
                assert!(seen.borrow().last().unwrap().get("historyRevision").is_none());
                client.status(false).await.unwrap();
                assert!(seen.borrow().last().unwrap().get("historyRevision").is_none(), "old guards always send history");
            })
            .await;
    }

    #[tokio::test]
    async fn concurrent_reads_share_one_request_but_mutations_fence_both_requests_and_cache() {
        LocalSet::new()
            .run_until(async {
                let name = pipe_name();
                let mut guard = fake_guard(&name);
                let client = Rc::new(GuardClient::on(&name));
                let (first, shared) = (client.status(false), client.status(false));
                let first = spawn_local(first);
                let shared = spawn_local(shared);
                let (r0, t0) = guard.recv().await.unwrap();
                assert_eq!(r0["command"], "status");
                let mutation = spawn_local({
                    let client = client.clone();
                    async move { client.mutate(json!({ "command": "end" })).await }
                });
                let (r1, t1) = guard.recv().await.unwrap();
                assert_eq!(r1["command"], "end");
                let during = spawn_local(client.status(false));
                let (_, t2) = guard.recv().await.unwrap();
                t1.send(Some(json!({ "history": [], "historyRevision": "new", "ok": true }))).unwrap();
                mutation.await.unwrap().unwrap();
                let after = spawn_local(client.status(false));
                let (_, t3) = guard.recv().await.unwrap();
                t0.send(Some(json!({ "history": [{ "id": "stale" }], "historyRevision": "old" }))).unwrap();
                first.await.unwrap().unwrap();
                shared.await.unwrap().unwrap();
                t2.send(Some(json!({ "history": [], "historyRevision": "during" }))).unwrap();
                during.await.unwrap().unwrap();
                t3.send(Some(json!({ "history": [{ "id": "current" }], "historyRevision": "new" }))).unwrap();
                after.await.unwrap().unwrap();
                let latest = spawn_local(client.status(false));
                let (r4, t4) = guard.recv().await.unwrap();
                assert_eq!(r4["historyRevision"], "new", "the stale reply never replaced the cache");
                t4.send(Some(json!({ "historyRevision": "new" }))).unwrap();
                assert_eq!(latest.await.unwrap().unwrap()["history"][0]["id"], "current");
            })
            .await;
    }

    #[tokio::test]
    async fn a_failed_mutation_invalidates_history_because_the_service_may_have_applied_it() {
        LocalSet::new()
            .run_until(async {
                let name = pipe_name();
                let mut guard = fake_guard(&name);
                let client = Rc::new(GuardClient::on(&name));
                let status = spawn_local(client.status(false));
                guard.recv().await.unwrap().1.send(Some(json!({ "history": [], "historyRevision": "one" }))).unwrap();
                status.await.unwrap().unwrap();
                let mutation = spawn_local({
                    let client = client.clone();
                    async move { client.mutate(json!({ "command": "end" })).await }
                });
                guard.recv().await.unwrap().1.send(None).unwrap();
                assert!(mutation.await.unwrap().is_err());
                let again = spawn_local(client.status(false));
                let (request, reply) = guard.recv().await.unwrap();
                assert!(request.get("historyRevision").is_none());
                reply.send(Some(json!({ "history": [], "historyRevision": "two" }))).unwrap();
                again.await.unwrap().unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn a_busy_or_late_listener_is_retried_but_a_submitted_request_is_never_replayed() {
        LocalSet::new()
            .run_until(async {
                let name = pipe_name();
                // The service appears only after a quarter of a second: the client keeps trying before it connects.
                let late = name.clone();
                let started = spawn_local(async move {
                    sleep(Duration::from_millis(250)).await;
                    let mut guard = fake_guard(&late);
                    let (request, reply) = guard.recv().await.unwrap();
                    assert_eq!(request["command"], "start");
                    reply.send(None).unwrap(); // disconnect right after the request was received
                    assert!(tokio::time::timeout(Duration::from_millis(600), guard.recv()).await.is_err(), "the request was submitted exactly once");
                });
                let error = request_on(&name, &json!({ "command": "start" }), Duration::from_secs(5)).await.unwrap_err();
                assert_eq!(error.message, "Windows protection disconnected.");
                started.await.unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn an_unavailable_service_stops_being_retried_and_reads_as_offline() {
        let started = std::time::Instant::now();
        let error = request_on(&pipe_name(), &json!({ "command": "status" }), Duration::from_secs(5)).await.unwrap_err();
        assert!(error.offline, "{}", error.message);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}