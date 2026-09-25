'use strict';

const todoFormats = [
  { type: 'checkbox', mark: '☐', name: 'Checkbox', description: 'A satisfying little tick', keywords: 'task tickbox square' },
  { type: 'circle', mark: '○', name: 'Tick circle', description: 'A softer way to check things off', keywords: 'task tickcircle round' },
  { type: 'bullet', mark: '•', name: 'Bullet list', description: 'Ideas without a particular order', keywords: 'unordered dot' },
  { type: 'number', mark: '1.', name: 'Numbered list', description: 'Steps to take in sequence', keywords: 'ordered steps' },
  { type: 'heading', mark: 'H', name: 'Heading', description: 'Give a few lines a shared purpose', keywords: 'title section' },
  { type: 'note', mark: '≡', name: 'Note', description: 'A thought or a little context', keywords: 'text paragraph plain' }
];
let todoMenu = null, todoSelection = null, todoHold = null, todoDrag = null, todoSkipClick = false, todoUndo = null, todoUndoTimer;

function closeTodoMenu() {
  document.querySelector('#todo-menu')?.remove();
  document.querySelectorAll('.todo-input').forEach(input => {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-controls');
  });
  todoMenu = null;
}

function todoProgress() {
  const tasks = prefs.todos.filter(item => ['checkbox', 'circle'].includes(item.type));
  $('#todo-progress').textContent = tasks.length ? `${tasks.filter(item => item.done).length} OF ${tasks.length} COMPLETE` : 'A FRESH PAGE';
}

function renderTodos(focusIndex, cursor) {
  closeTodoMenu();
  let number = 0;
  $('#todo-rows').innerHTML = prefs.todos.map((item, index) => {
    number = item.type === 'number' ? number + 1 : 0;
    const task = ['checkbox', 'circle'].includes(item.type);
    const picked = !!todoSelection?.has(item);
    const mark = todoSelection ? `<button class="todo-check circle todo-select" role="checkbox" aria-checked="${picked}" aria-label="Select line ${index + 1}" data-todo-select>${picked ? icon('check') : ''}</button>` : task ? `<button class="todo-check ${item.type}" role="checkbox" aria-checked="${item.done}" aria-label="Complete line ${index + 1}" data-todo-check>${item.done ? icon('check') : ''}</button>` : `<span class="todo-marker" aria-hidden="true">${item.type === 'number' ? number + '.' : item.type === 'bullet' ? '•' : item.type === 'heading' ? 'H' : '—'}</span>`;
    const end = todoSelection ? `<button class="todo-handle icon-button" aria-label="Move line ${index + 1}. Drag, or press the up and down arrow keys" data-todo-handle><svg viewBox="0 0 20 24" aria-hidden="true"><path d="m5 9 5-5 5 5M5 15l5 5 5-5"/></svg></button>` : `<button class="todo-delete icon-button" aria-label="Delete line ${index + 1}" data-todo-delete>${icon('close')}</button>`;
    return `<div class="todo-row ${item.type}${task && item.done ? ' done' : ''}${picked ? ' selected' : ''}" data-todo-index="${index}"><div class="todo-line">${mark}<input class="todo-input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" aria-label="Line ${index + 1}, ${todoFormats.find(format => format.type === item.type).name}" maxlength="2000" value="${escapeHtml(item.text)}" placeholder="${item.type === 'heading' ? 'Give this section a name…' : 'Write something, or type / for formats…'}"${todoSelection ? ' readonly tabindex="-1"' : ''}>${end}</div></div>`;
  }).join('');
  todoProgress();
  $('#todo-rows').classList.toggle('selecting', !!todoSelection);
  $('#todo-select-bar').hidden = !todoSelection; $('#todo-add').hidden = !!todoSelection;
  if (todoSelection) {
    const all = todoSelection.size === prefs.todos.length;
    $('#todo-select-count').textContent = `${todoSelection.size} SELECTED`;
    $('#todo-select-all').textContent = all ? 'Select none' : 'Select all';
    $('#todo-select-delete').disabled = !todoSelection.size;
  }
  if (focusIndex !== undefined) {
    const input = $$('.todo-input')[focusIndex];
    input?.focus();
    if (cursor !== undefined) input?.setSelectionRange(cursor, cursor);
  }
}

function openTodoMenu(input) {
  closeTodoMenu();
  const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(?:^|\s)\/([^/\s]*)$/);
  if (!match) return;
  const query = match[1].toLowerCase();
  const options = todoFormats.filter(format => `${format.name} ${format.keywords}`.toLowerCase().includes(query));
  todoMenu = { input, start: before.lastIndexOf('/'), end: input.selectionStart, options, selected: 0 };
  const menu = document.createElement('div');
  menu.id = 'todo-menu'; menu.className = 'todo-menu';
  menu.innerHTML = `<div class="todo-menu-title">TURN THIS LINE INTO <span>↑ ↓ to choose · Esc to close</span></div><div id="todo-options" role="listbox" aria-label="Line formats">${options.map((format, index) => `<button id="todo-option-${index}" role="option" aria-selected="${index === 0}" data-todo-format="${index}" tabindex="-1"><span class="todo-format-mark">${format.mark}</span><span><strong>${format.name}</strong><small>${format.description}</small></span></button>`).join('')}</div>${options.length ? '' : '<p>No matching formats. Try “check” or “note”.</p>'}`;
  input.closest('.todo-row').append(menu);
  menu.scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'todo-options');
  if (options.length) input.setAttribute('aria-activedescendant', 'todo-option-0');
  menu.addEventListener('mousedown', event => event.preventDefault());
  menu.addEventListener('click', event => { const option = event.target.closest('[data-todo-format]'); if (option) chooseTodoFormat(Number(option.dataset.todoFormat)); });
}

function chooseTodoFormat(optionIndex) {
  const { input, start, end, options } = todoMenu;
  const index = Number(input.closest('.todo-row').dataset.todoIndex);
  const item = prefs.todos[index];
  item.text = input.value.slice(0, start) + input.value.slice(end);
  item.type = options[optionIndex].type;
  if (!['checkbox', 'circle'].includes(item.type)) item.done = false;
  renderTodos(index, start); save();
}

function addTodo(index, type = 'checkbox', text = '') {
  if (prefs.todos.length >= 500) { toast('Your list has room for 500 lines. Remove a line to add another.', true); return false; }
  prefs.todos.splice(index, 0, { type, text, done: false });
  return true;
}

function cancelTodoHold() { clearTimeout(todoHold?.timer); todoHold = null; }

function startTodoSelection(index) {
  cancelTodoHold();
  if (todoSelection) return;
  todoSelection = new Set([prefs.todos[index]]);
  renderTodos(); $$('[data-todo-select]')[index]?.focus();
}

function stopTodoSelection() { todoSelection = null; todoDrag = null; renderTodos(); }

function moveTodo(from, to) {
  if (to < 0 || to >= prefs.todos.length) return;
  prefs.todos.splice(to, 0, prefs.todos.splice(from, 1)[0]);
  renderTodos(); $$('[data-todo-handle]')[to].focus(); save();
}

function deleteSelectedTodos() {
  // Remember each line's place so Undo can put it back even if the list changed meanwhile.
  todoUndo = prefs.todos.map((item, index) => ({ item, index })).filter(({ item }) => todoSelection.has(item));
  prefs.todos.splice(0, prefs.todos.length, ...prefs.todos.filter(item => !todoSelection.has(item)));
  if (!prefs.todos.length) addTodo(0);
  todoSelection = null; renderTodos(); save();
  $('#todo-undo').hidden = false; clearTimeout(todoUndoTimer);
  todoUndoTimer = setTimeout(() => { $('#todo-undo').hidden = true; todoUndo = null; }, 15000);
  toast(`Deleted ${todoUndo.length} line${todoUndo.length === 1 ? '' : 's'}.`);
}

function undoTodoDelete() {
  if (!todoUndo) return;
  if (prefs.todos.length + todoUndo.length > 500) { toast('Your list has room for 500 lines. Remove a few lines to undo.', true); return; }
  if (prefs.todos.length === 1 && !prefs.todos[0].text) prefs.todos.length = 0;
  todoUndo.forEach(({ item, index }) => prefs.todos.splice(Math.min(index, prefs.todos.length), 0, item));
  todoUndo = null; clearTimeout(todoUndoTimer); $('#todo-undo').hidden = true;
  renderTodos(); save();
}

function initTodos() {
  prefs.todos = prefs.todos?.length ? prefs.todos : [{ type: 'checkbox', text: '', done: false }];
  renderTodos();
  if (!window.still) $('#todo-save-status').textContent = 'Preview only · not saved';
  $('#todo-add').onclick = () => { if (addTodo(prefs.todos.length)) { renderTodos(prefs.todos.length - 1); save(); } };
  $('#todo-rows').addEventListener('input', event => {
    if (!event.target.matches('.todo-input')) return;
    prefs.todos[Number(event.target.closest('.todo-row').dataset.todoIndex)].text = event.target.value;
    openTodoMenu(event.target); save();
  });
  $('#todo-rows').addEventListener('keydown', event => {
    const input = event.target;
    if (input.matches('[data-todo-handle]') && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const from = Number(input.closest('.todo-row').dataset.todoIndex);
      return moveTodo(from, from + (event.key === 'ArrowUp' ? -1 : 1));
    }
    if (!input.matches('.todo-input') || input.readOnly || event.isComposing) return;
    const index = Number(input.closest('.todo-row').dataset.todoIndex);
    if (todoMenu && todoMenu.input === input) {
      if (event.key === 'Escape') { event.preventDefault(); closeTodoMenu(); return; }
      if (todoMenu.options.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'Enter') return chooseTodoFormat(todoMenu.selected);
        todoMenu.selected = (todoMenu.selected + (event.key === 'ArrowDown' ? 1 : -1) + todoMenu.options.length) % todoMenu.options.length;
        $$('#todo-options [role=option]').forEach((option, i) => option.setAttribute('aria-selected', i === todoMenu.selected));
        input.setAttribute('aria-activedescendant', `todo-option-${todoMenu.selected}`);
        document.getElementById(`todo-option-${todoMenu.selected}`).scrollIntoView({ block: 'nearest' });
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) closeTodoMenu();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = prefs.todos[index], start = input.selectionStart, end = input.selectionEnd;
      if (!addTodo(index + 1, item.type === 'heading' ? 'checkbox' : item.type, item.text.slice(end))) return;
      item.text = item.text.slice(0, start); renderTodos(index + 1, 0); save();
    } else if (event.key === 'Backspace' && !input.value && prefs.todos.length > 1) {
      event.preventDefault(); prefs.todos.splice(index, 1); renderTodos(Math.max(0, index - 1)); save();
    }
  });
  $('#todo-rows').addEventListener('click', event => {
    if (todoSkipClick) { todoSkipClick = false; return; }
    const row = event.target.closest('.todo-row'); if (!row) return;
    const index = Number(row.dataset.todoIndex);
    if (todoSelection) {
      if (event.target.closest('[data-todo-handle]')) return;
      const item = prefs.todos[index];
      if (!todoSelection.delete(item)) todoSelection.add(item);
      renderTodos(); $$('[data-todo-select]')[index].focus();
    } else if (event.target.closest('[data-todo-check]')) {
      prefs.todos[index].done = !prefs.todos[index].done; renderTodos();
      $$('.todo-row')[index].querySelector('[data-todo-check]').focus(); save();
    } else if (event.target.closest('[data-todo-delete]')) {
      prefs.todos.splice(index, 1); if (!prefs.todos.length) addTodo(0);
      renderTodos(Math.min(index, prefs.todos.length - 1)); save();
    } else if (event.target.matches('.todo-input')) closeTodoMenu();
  });
  document.addEventListener('focusin', event => { if (todoMenu && event.target !== todoMenu.input && !event.target.closest('#todo-menu')) closeTodoMenu(); });
  document.addEventListener('pointerdown', event => { if (todoMenu && event.target !== todoMenu.input && !event.target.closest('#todo-menu')) closeTodoMenu(); });
  // Hold a line (or right-click / Shift+F10) to select, delete and reorder lines.
  $('#todo-rows').addEventListener('pointerdown', event => {
    todoSkipClick = false;
    const row = event.target.closest('.todo-row'), handle = event.target.closest('[data-todo-handle]');
    if (!row || event.button !== 0 || event.target.closest('#todo-menu')) return;
    if (todoSelection && handle) {
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      todoDrag = row; row.classList.add('dragging');
    } else if (!todoSelection) {
      todoHold = { x: event.clientX, y: event.clientY, timer: setTimeout(() => { todoSkipClick = true; startTodoSelection(Number(row.dataset.todoIndex)); }, 500) };
    }
  });
  $('#todo-rows').addEventListener('contextmenu', event => {
    const row = event.target.closest('.todo-row');
    if (!row || todoSelection || event.target.closest('#todo-menu')) return;
    event.preventDefault(); todoSkipClick = !!todoHold; startTodoSelection(Number(row.dataset.todoIndex));
  });
  document.addEventListener('pointermove', event => {
    if (todoHold && Math.hypot(event.clientX - todoHold.x, event.clientY - todoHold.y) > 8) cancelTodoHold();
    if (!todoDrag) return;
    // The dragged line goes before the first other line whose middle is below the pointer.
    const next = $$('.todo-row').find(row => row !== todoDrag && event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2);
    if (next && todoDrag.nextElementSibling !== next) next.before(todoDrag);
    else if (!next && todoDrag.nextElementSibling) $('#todo-rows').append(todoDrag);
  });
  const endDrag = () => {
    cancelTodoHold();
    if (!todoDrag) return;
    const order = $$('.todo-row').map(row => prefs.todos[row.dataset.todoIndex]), changed = order.some((item, i) => item !== prefs.todos[i]);
    todoDrag = null; todoSkipClick = true;
    prefs.todos.splice(0, prefs.todos.length, ...order); renderTodos();
    if (changed) save();
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', event => { if (todoSelection && event.key === 'Escape' && !document.querySelector('dialog[open]')) stopTodoSelection(); });
  $('#todo-select-all').onclick = () => { todoSelection = new Set(todoSelection.size === prefs.todos.length ? [] : prefs.todos); renderTodos(); $('#todo-select-all').focus(); };
  $('#todo-select-delete').onclick = deleteSelectedTodos;
  $('#todo-select-cancel').onclick = stopTodoSelection;
  $('#todo-undo').onclick = undoTodoDelete;
}
