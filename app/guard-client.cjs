// Cache history only; every read still asks the service for live session state.
function createGuardClient(request) {
  let history, revision, pending, generation = 0, mutations = 0;
  function invalidate() { generation++; pending = null; history = revision = undefined; }
  function status(full = false) {
    if (!full && !mutations && pending) return pending;
    const epoch = generation, cachedHistory = history;
    const query = { command: 'status' };
    if (!full && revision && cachedHistory) query.historyRevision = revision;
    const result = request(query, 3500).then(value => {
      const records = value.history ?? cachedHistory;
      if (!Array.isArray(records)) throw Error('Invalid protection history response.');
      if (epoch === generation) { history = records; revision = value.historyRevision; }
      return { ...value, history: records };
    }).catch(error => { if (epoch === generation) invalidate(); throw error; });
    if (!full && !mutations) pending = result;
    result.finally(() => { if (pending === result) pending = null; }).catch(() => {});
    return result;
  }
  async function mutate(value) {
    invalidate(); mutations++;
    try { return await request(value); }
    finally { mutations--; invalidate(); }
  }
  return { status, mutate, invalidate, get generation() { return generation; } };
}
module.exports = { createGuardClient };
