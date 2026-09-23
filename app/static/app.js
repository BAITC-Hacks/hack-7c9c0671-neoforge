'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let currentId = null;
let currentReport = null;

const editor = $('#editor');
const loading = $('#loading');
const audioInput = $('#audio-input');
const dropzone = $('#dropzone');

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
      ['ASR', data.asr_model],
      ['Диаризация', data.diarization_model],
      ['Демо', data.demo_available],
    ].map(([label, ready]) => `<span class="health-chip ${ready ? 'ok' : 'warn'}">${ready ? '●' : '○'} ${label}: ${ready ? 'готово' : 'нужна модель'}</span>`).join('');
  } catch {
    $('#health').classList.remove('skeleton');
    $('#health').innerHTML = '<span class="health-chip warn">○ Сервер недоступен</span>';
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
  $('#save-status').textContent = 'Изменения ещё не сохранены';
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
    <article class="action-card ${action.needs_review ? 'review-needed' : ''}" data-action-row="${index}">
      <label class="action-field"><span>Поручение</span><textarea data-index="${index}" data-key="task">${escapeHtml(action.task)}</textarea></label>
      <label class="action-field"><span>Ответственный</span><input data-index="${index}" data-key="responsible" value="${escapeAttribute(action.responsible)}"></label>
      <label class="action-field"><span>Срок</span><input data-index="${index}" data-key="deadline" value="${escapeAttribute(action.deadline)}"></label>
      <label class="action-field status-field"><span>Статус</span><select data-index="${index}" data-key="status"><option value="draft" ${!action.status || action.status === 'draft' ? 'selected' : ''}>Черновик</option><option value="in_progress" ${action.status === 'in_progress' ? 'selected' : ''}>В работе</option><option value="done" ${action.status === 'done' ? 'selected' : ''}>Выполнено</option></select></label>
      <label class="review-toggle"><input type="checkbox" data-index="${index}" data-key="reviewed" ${action.needs_review ? '' : 'checked'}><span>Проверено</span></label>
      <button class="remove-action" type="button" data-remove-action="${index}" aria-label="Удалить поручение">×</button>
    </article>`).join('') : '<div class="empty-actions">Поручений пока нет. Добавьте их вручную.</div>';
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
  currentReport.actions.push({task: 'Новое поручение', responsible: 'Не указан / көрсетілмеген', deadline: 'Не указан / көрсетілмеген', status: 'draft', needs_review: true});
  drawActions();
  $$('[data-action-row]').at(-1)?.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function removeAction(index) {
  syncActions();
  currentReport.actions.splice(index, 1);
  drawActions();
  $('#save-status').textContent = 'Есть несохранённые изменения';
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
    title: $('#report-title').value.trim(),
    summary: $('#summary').value.split('\n').map(item => item.trim()).filter(Boolean),
    actions: currentReport.actions.map(action => ({task: action.task.trim(), responsible: action.responsible.trim(), deadline: action.deadline.trim(), status: action.status || 'draft', needs_review: action.needs_review})),
  };
  try {
    const data = await fetchJson(`/reports/${currentId}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    renderReport(data);
    status.className = 'save-message success';
    status.textContent = 'Сохранено · PDF, DOCX и JSON обновлены';
    await loadHistory();
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
  const data = new FormData(event.currentTarget);
  showLoading('Обрабатываем запись', 'ASR, диаризация и извлечение поручений');
  try {
    renderReport(await fetchJson('/process', {method: 'POST', body: data}));
    await loadHistory();
    toast('Аудио обработано локально');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    hideLoading();
  }
});

audioInput.addEventListener('change', () => {
  const file = audioInput.files?.[0];
  $('#file-label').textContent = file ? file.name : 'Перетащите аудио сюда';
  dropzone.classList.toggle('has-file', Boolean(file));
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
  if (demo) createDemo(demo.dataset.demo);
  if (report) openReport(report.dataset.openReport);
  if (remove) removeAction(Number(remove.dataset.removeAction));
});

$('#add-action').addEventListener('click', addAction);
$('#save-report').addEventListener('click', saveReport);
$('#refresh-history').addEventListener('click', loadHistory);
$('#editor').addEventListener('input', () => {$('#save-status').textContent = 'Есть несохранённые изменения';});

loadHealth();
loadHistory();
