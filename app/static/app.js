'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let currentId = null;
let currentReport = null;
let isDirty = false;

const editor = $('#editor');
const loading = $('#loading');
const audioInput = $('#audio-input');
const dropzone = $('#dropzone');

function setDirty(value, message = '') {
  isDirty = value;
  $('#dirty-indicator').classList.toggle('active', value);
  if (message) $('#save-status').textContent = message;
}

function canReplaceDraft() {
  return !isDirty || window.confirm('В текущем протоколе есть несохранённые изменения. Продолжить без сохранения?');
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function showLoading(title, text) {
  $('#loading-title').textContent = title;
  $('#loading-text').textContent = text;
  loading.hidden = false;
  $('#job-progress-bar').style.width = '0%';
  $('#job-progress-value').textContent = '';
  document.body.style.overflow = 'hidden';
}

function hideLoading() {
  loading.hidden = true;
  document.body.style.overflow = '';
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  $('#toast-region').append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function formatDate(value) {
  if (!value) return 'Дата не указана';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ru-RU', {dateStyle: 'medium', timeStyle: 'short'}).format(date);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatError(data.detail));
  return data;
}

function formatError(detail) {
  if (Array.isArray(detail)) return detail.map(item => item.msg).join('; ');
  return detail || 'Не удалось выполнить запрос';
}

async function loadHealth() {
  try {
    const data = await fetchJson('/health');
    $('#health').classList.remove('skeleton');
    $('#health').innerHTML = [
      ['ASR', data.asr_model, 'нужна модель'],
      ['Диаризация', data.diarization_model, 'нужна модель'],
      ['FFmpeg', data.ffmpeg, 'не найден'],
      ['Демо', data.demo_available, 'недоступно'],
    ].map(([label, ready, missing]) => `<span class="health-chip ${ready ? 'ok' : 'warn'}">${ready ? '●' : '○'} ${label}: ${ready ? 'готово' : missing}</span>`).join('');
  } catch {
    $('#health').classList.remove('skeleton');
    $('#health').innerHTML = '<span class="health-chip warn">○ Сервер недоступен</span>';
  }
}

const sleep = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));

async function waitForJob(job) {
  const stageLabels = {
    upload: 'Файл серверге жүктелді · файл загружен',
    transcription: 'Распознаём речь локально',
    diarization: 'Разделяем реплики по говорящим',
    report: 'Формируем поручения и экспорт',
    completed: 'Протокол готов',
  };
  let state = job;
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    $('#job-progress-bar').style.width = `${progress}%`;
    $('#job-progress-value').textContent = `${progress}%`;
    $('#loading-text').textContent = stageLabels[state.stage] || 'Обрабатываем запись локально';
    if (state.status === 'completed') return fetchJson(`/reports/${state.report_id || state.id}`);
    if (state.status === 'failed') throw new Error(state.error || 'Не удалось обработать запись');
    await sleep(1000);
    state = await fetchJson(`/jobs/${state.id}`);
  }
  throw new Error('Превышено время ожидания обработки');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderSelectedFile(file) {
  const panel = $('#selected-file');
  panel.hidden = !file;
  dropzone.hidden = Boolean(file);
  dropzone.classList.toggle('has-file', Boolean(file));
  $('#file-label').textContent = file ? file.name : 'Перетащите аудио сюда';
  if (file) {
    $('#selected-file-name').textContent = file.name;
    $('#selected-file-meta').textContent = `${formatBytes(file.size)} · готов к локальной обработке`;
  }
}

async function loadDashboard() {
  try {
    const data = await fetchJson('/dashboard');
    $('#dashboard').innerHTML = `<div><b>${data.actions}</b><span>Поручений</span></div><div><b>${data.completion_percent}%</b><span>Выполнено</span></div><div><b>${data.needs_review}</b><span>На проверку</span></div>`;
  } catch {
    $('#dashboard').innerHTML = '<div><b>—</b><span>Нет данных</span></div>';
  }
}

async function loadHistory() {
  const container = $('#history');
  try {
    const items = await fetchJson('/reports');
    container.innerHTML = items.length ? items.slice(0, 8).map(item => `
      <div class="history-item">
        <div class="history-main"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(formatDate(item.created_at))} · ${item.stats?.actions ?? 0} поручений</span></div>
        <button class="history-open" type="button" data-open-report="${item.id}">Открыть →</button>
      </div>`).join('') : '<div class="history-empty">Здесь появятся ваши протоколы</div>';
  } catch {
    container.innerHTML = '<div class="history-empty">Не удалось загрузить историю</div>';
  }
}

async function createDemo(id) {
  showLoading('Формируем демо-протокол', `Совещание №${id} · локальная обработка`);
  try {
    renderReport(await fetchJson(`/demo/${id}`, {method: 'POST'}));
    await loadHistory();
    await loadDashboard();
    toast('Черновик готов. Проверьте поручения перед экспортом.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

async function openReport(id) {
  showLoading('Открываем протокол', 'Загружаем сохранённые данные');
  try {
    renderReport(await fetchJson(`/reports/${id}`));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

function renderReport(payload) {
  currentId = payload.id;
  currentReport = payload.report;
  setDirty(false);
  const report = currentReport;
  const stats = report.stats || {};
  editor.hidden = false;
  $('#report-title').value = report.title || '';
  $('#summary').value = (report.summary || []).join('\n');
  $('#metrics').innerHTML = [
    ['Говорящих', stats.speakers || 0],
    ['Сегментов', stats.segments || 0],
    ['Поручений', (report.actions || []).length],
    ['На проверку', (report.actions || []).filter(action => action.needs_review).length],
  ].map(([label, value]) => `<div class="metric"><b>${value}</b><span>${label}</span></div>`).join('');
  $('#downloads').innerHTML = ['pdf', 'docx', 'json'].map(kind => `<a class="download" href="/download/${payload.id}/${kind}" download>↓ ${kind.toUpperCase()}</a>`).join('');
  drawActions();
  const segments = report.segments || [];
  $('#transcript-count').textContent = `${segments.length} реплик`;
  $('#transcript').className = 'transcript-body';
  $('#transcript').innerHTML = segments.map(segment => `<div class="transcript-line"><b>${formatTime(segment.start)}–${formatTime(segment.end)} · ${escapeHtml(segment.speaker)}</b><br>${escapeHtml(segment.text)}</div>`).join('');
  $('#save-status').textContent = `Версия ${report.revision || 1} · все изменения сохранены`;
  $('#action-search').value = '';
  $('#status-filter').value = 'all';
  filterActions();
  editor.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}

function drawActions() {
  const container = $('#actions');
  const actions = currentReport?.actions || [];
  container.innerHTML = actions.length ? actions.map((action, index) => `
    <article class="action-card ${action.needs_review ? 'review-needed' : ''}" data-action-row="${index}" data-status="${action.status || 'draft'}" data-review="${action.needs_review}" data-search="${escapeAttribute(`${action.task} ${action.responsible}`.toLocaleLowerCase('ru'))}">
      <label class="action-field"><span>Поручение</span><textarea data-index="${index}" data-key="task">${escapeHtml(action.task)}</textarea></label>
      <label class="action-field"><span>Ответственный</span><input data-index="${index}" data-key="responsible" value="${escapeAttribute(action.responsible)}"></label>
      <label class="action-field"><span>Срок</span><input data-index="${index}" data-key="deadline" value="${escapeAttribute(action.deadline)}"></label>
      <label class="action-field status-field"><span>Статус</span><select data-index="${index}" data-key="status"><option value="draft" ${!action.status || action.status === 'draft' ? 'selected' : ''}>Черновик</option><option value="in_progress" ${action.status === 'in_progress' ? 'selected' : ''}>В работе</option><option value="done" ${action.status === 'done' ? 'selected' : ''}>Выполнено</option></select></label>
      <label class="review-toggle"><input type="checkbox" data-index="${index}" data-key="reviewed" ${action.needs_review ? '' : 'checked'}><span>Проверено</span></label>
      <button class="remove-action" type="button" data-remove-action="${index}" aria-label="Удалить поручение">×</button>
    </article>`).join('') : '<div class="empty-actions">Поручений пока нет. Добавьте их вручную.</div>';
}

function filterActions() {
  const query = $('#action-search').value.trim().toLocaleLowerCase('ru');
  const status = $('#status-filter').value;
  let visible = 0;
  $$('[data-action-row]').forEach(card => {
    const matchesText = !query || card.dataset.search.includes(query);
    const matchesStatus = status === 'all' || (status === 'review' ? card.dataset.review === 'true' : card.dataset.status === status);
    card.classList.toggle('filtered-out', !(matchesText && matchesStatus));
    if (matchesText && matchesStatus) visible += 1;
  });
  const total = currentReport?.actions?.length || 0;
  $('#filter-count').textContent = `${visible} из ${total}`;
  $('#actions').classList.toggle('no-filter-results', total > 0 && visible === 0);
}

function syncActions() {
  $$('[data-index]', $('#actions')).forEach(element => {
    const action = currentReport.actions[Number(element.dataset.index)];
    if (!action) return;
    if (element.dataset.key === 'reviewed') action.needs_review = !element.checked;
    else action[element.dataset.key] = element.value;
  });
}

function addAction() {
  syncActions();
  currentReport.actions.push({id: crypto.randomUUID().replaceAll('-', ''), task: 'Новое поручение', responsible: 'Не указан / көрсетілмеген', deadline: 'Не указан / көрсетілмеген', status: 'draft', needs_review: true});
  setDirty(true, 'Есть несохранённые изменения');
  drawActions();
  filterActions();
  $$('[data-action-row]').at(-1)?.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function removeAction(index) {
  if (!window.confirm('Удалить это поручение?')) return;
  syncActions();
  currentReport.actions.splice(index, 1);
  setDirty(true, 'Есть несохранённые изменения');
  drawActions();
  filterActions();
}

async function saveReport() {
  if (!currentId || !currentReport) return;
  syncActions();
  const button = $('#save-report');
  const status = $('#save-status');
  button.disabled = true;
  status.className = 'save-message';
  status.textContent = 'Сохраняем и обновляем файлы…';
  const payload = {
    revision: currentReport.revision,
    title: $('#report-title').value.trim(),
    summary: $('#summary').value.split('\n').map(item => item.trim()).filter(Boolean),
    actions: currentReport.actions.map(action => ({id: action.id, task: action.task.trim(), responsible: action.responsible.trim(), deadline: action.deadline.trim(), status: action.status || 'draft', needs_review: action.needs_review})),
  };
  try {
    const data = await fetchJson(`/reports/${currentId}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    renderReport(data);
    status.className = 'save-message success';
    status.textContent = 'Сохранено · PDF, DOCX и JSON обновлены';
    setDirty(false);
    await loadHistory();
    await loadDashboard();
    toast('Протокол сохранён');
  } catch (error) {
    status.className = 'save-message error';
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$('#upload').addEventListener('submit', async event => {
  event.preventDefault();
  if (!canReplaceDraft()) return;
  const data = new FormData(event.currentTarget);
  showLoading('Обрабатываем запись', 'ASR, диаризация и извлечение поручений');
  try {
    const job = await fetchJson('/process', {method: 'POST', body: data});
    renderReport(await waitForJob(job));
    await loadHistory();
    await loadDashboard();
    toast('Аудио обработано локально');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    hideLoading();
  }
});

audioInput.addEventListener('change', () => {
  const file = audioInput.files?.[0];
  if (file && file.size > 100 * 1024 * 1024) {
    audioInput.value = '';
    renderSelectedFile(null);
    toast('Файл превышает лимит 100 МБ', 'error');
    return;
  }
  renderSelectedFile(file);
});

$('#clear-file').addEventListener('click', () => {
  audioInput.value = '';
  renderSelectedFile(null);
});

['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => {event.preventDefault(); dropzone.classList.add('dragging');}));
['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, event => {event.preventDefault(); dropzone.classList.remove('dragging');}));
dropzone.addEventListener('drop', event => {
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  audioInput.files = transfer.files;
  audioInput.dispatchEvent(new Event('change'));
});

document.addEventListener('click', event => {
  const demo = event.target.closest('[data-demo]');
  const report = event.target.closest('[data-open-report]');
  const remove = event.target.closest('[data-remove-action]');
  if (demo && canReplaceDraft()) createDemo(demo.dataset.demo);
  if (report && canReplaceDraft()) openReport(report.dataset.openReport);
  if (remove) removeAction(Number(remove.dataset.removeAction));
});

$('#add-action').addEventListener('click', addAction);
$('#save-report').addEventListener('click', saveReport);
$('#refresh-history').addEventListener('click', loadHistory);
$('#action-search').addEventListener('input', filterActions);
$('#status-filter').addEventListener('change', filterActions);
$('#editor').addEventListener('input', event => {
  if (event.target.closest('.action-filters')) return;
  setDirty(true, 'Есть несохранённые изменения');
  const card = event.target.closest('[data-action-row]');
  if (card && ['task', 'responsible'].includes(event.target.dataset.key)) {
    const fields = $$('[data-key="task"], [data-key="responsible"]', card);
    card.dataset.search = fields.map(field => field.value).join(' ').toLocaleLowerCase('ru');
  }
});
$('#editor').addEventListener('change', event => {
  if (event.target.closest('.action-filters')) return;
  setDirty(true, 'Есть несохранённые изменения');
  const card = event.target.closest('[data-action-row]');
  if (card && event.target.dataset.key === 'status') card.dataset.status = event.target.value;
  if (card && event.target.dataset.key === 'reviewed') card.dataset.review = String(!event.target.checked);
  filterActions();
});
window.addEventListener('beforeunload', event => {if (isDirty) {event.preventDefault(); event.returnValue = '';}});

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's' && currentReport) {
    event.preventDefault();
    saveReport();
  }
});

const savedTheme = localStorage.getItem('meeting-assistant-theme') || localStorage.getItem('qazmeeting-theme');
if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark';
function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme-toggle').textContent = dark ? '☀' : '☾';
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
}
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  localStorage.setItem('meeting-assistant-theme', dark ? 'dark' : 'light');
  syncThemeButton();
});
syncThemeButton();

loadHealth();
loadHistory();
loadDashboard();
