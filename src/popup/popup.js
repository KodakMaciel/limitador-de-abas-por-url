// popup.js — interface de CRUD das regras e das ações.
//
// Toda gravação passa pelo storage.js, que valida a entrada e serializa as
// escritas. A interface só mostra a mensagem que vem de volta (regra 13).
// Nada de innerHTML com texto do usuário: os nós são montados um a um.

import {
  LIMIT_MAX,
  LIMIT_MIN,
  addRule,
  getConfig,
  moveRule,
  removeRule,
  updateRule,
  updateSettings
} from '../lib/storage.js';
import { suggestPatterns } from '../lib/matcher.js';
import { compileRules, countByRule, formatBadgeText, queryTabs } from '../lib/counter.js';

// A ordem aqui é a ordem das opções no <select> de cada regra, e as chaves são
// os valores gravados no storage (ver GLOBAL_ACTIONS em storage.js).
const ACTION_LABELS = {
  close: 'Fechar a aba nova',
  closeQuiet: 'Fechar sozinho',
  block: 'Bloquear com aviso',
  notify: 'Só avisar'
};

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  counts: new Map(),
  editingId: null,
  confirmingId: null,
  // O que estiver digitado no formulário de edição aberto e ainda não salvo.
  // Sem guardar isto, mexer em Limite/Ação/Ativa da mesma linha redesenha a
  // lista e apaga a digitação sem avisar.
  editDraft: null
};

/** Monta um elemento sem passar por innerHTML. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Carga e desenho
// ---------------------------------------------------------------------------

async function load() {
  const config = await getConfig();
  const compiled = compileRules(config.rules);
  const tabs = await queryTabs();

  state.config = config;
  state.counts = countByRule(tabs, compiled);

  renderSettings();
  renderRules();
}

function renderSettings() {
  const { settings } = state.config;
  for (const radio of document.querySelectorAll('input[name="defaultAction"]')) {
    radio.checked = radio.value === settings.defaultAction;
  }
  $('notifyOnEnforce').checked = settings.notifyOnEnforce;
  $('enforceOnStartup').checked = settings.enforceOnStartup;
}

/** Guarda o conteúdo do formulário de edição antes de a linha ser remontada. */
function captureEditDraft() {
  if (state.editingId === null) return;
  const patternInput = $('rules').querySelector('[data-field="editPattern"]');
  const labelInput = $('rules').querySelector('[data-field="editLabel"]');
  if (patternInput && labelInput) {
    state.editDraft = { pattern: patternInput.value, label: labelInput.value };
  }
}

function renderRules() {
  const container = $('rules');
  captureEditDraft();
  container.textContent = '';

  const { rules } = state.config;
  $('emptyRules').hidden = rules.length > 0;
  $('ruleCount').textContent = rules.length === 1 ? '1 regra' : `${rules.length} regras`;

  rules.forEach((rule, index) => {
    container.appendChild(ruleRow(rule, index, rules.length));
  });
}

function countClass(disabled, count, limit) {
  if (disabled) return 'count na';
  return count >= limit ? 'count full' : 'count';
}

function ruleRow(rule, index, total) {
  const disabled = rule.enabled === false;
  const count = state.counts.get(rule.id) ?? 0;

  const row = el('div', { class: disabled ? 'rule off' : 'rule', 'data-id': rule.id });

  row.appendChild(
    el('div', { class: 'rule-top' }, [
      el('span', { class: 'rule-order', text: `${index + 1}º` }),
      el('span', {
        class: 'rule-name',
        text: rule.label || rule.pattern,
        title: rule.label || rule.pattern
      }),
      el('span', {
        class: countClass(disabled, count, rule.limit),
        text: disabled ? '—' : formatBadgeText(count, rule.limit),
        title: disabled ? 'Regra desativada' : 'Abas abertas / limite'
      })
    ])
  );

  row.appendChild(el('code', { class: 'rule-pattern', text: rule.pattern }));

  const actionSelect = el('select', { 'data-field': 'action' });
  actionSelect.appendChild(
    el('option', {
      value: 'default',
      text: `Padrão global (${ACTION_LABELS[state.config.settings.defaultAction]})`
    })
  );
  for (const [value, text] of Object.entries(ACTION_LABELS)) {
    actionSelect.appendChild(el('option', { value, text }));
  }
  actionSelect.value = rule.action;

  row.appendChild(
    el('div', { class: 'rule-controls' }, [
      el('label', { class: 'field small' }, [
        el('span', { text: 'Limite' }),
        el('input', {
          type: 'number',
          value: String(rule.limit),
          min: String(LIMIT_MIN),
          max: String(LIMIT_MAX),
          step: '1',
          'data-field': 'limit'
        })
      ]),
      el('label', { class: 'field grow' }, [el('span', { text: 'Ação' }), actionSelect]),
      el('label', { class: 'chk' }, [
        el('input', { type: 'checkbox', checked: !disabled, 'data-field': 'enabled' }),
        el('span', { text: 'Ativa' })
      ])
    ])
  );

  row.appendChild(
    el('div', { class: 'rule-buttons' }, [
      el('button', {
        type: 'button',
        class: 'icon',
        text: '↑',
        title: 'Aumentar a prioridade',
        disabled: index === 0,
        'data-act': 'up'
      }),
      el('button', {
        type: 'button',
        class: 'icon',
        text: '↓',
        title: 'Diminuir a prioridade',
        disabled: index === total - 1,
        'data-act': 'down'
      }),
      el('div', { class: 'spacer' }),
      el('button', { type: 'button', text: 'Editar', 'data-act': 'edit' }),
      el('button', {
        type: 'button',
        class: 'danger',
        text: state.confirmingId === rule.id ? 'Confirmar exclusão' : 'Excluir',
        'data-act': 'remove'
      })
    ])
  );

  if (state.editingId === rule.id) {
    row.appendChild(
      el('div', { class: 'rule-edit' }, [
        el('label', { class: 'field' }, [
          el('span', { text: 'Padrão de URL' }),
          el('input', {
            type: 'text',
            value: state.editDraft?.pattern ?? rule.pattern,
            'data-field': 'editPattern'
          })
        ]),
        el('label', { class: 'field' }, [
          el('span', { text: 'Nome' }),
          el('input', {
            type: 'text',
            value: state.editDraft?.label ?? rule.label,
            maxLength: 60,
            'data-field': 'editLabel'
          })
        ]),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', text: 'Salvar', 'data-act': 'save' }),
          el('button', { type: 'button', text: 'Cancelar', 'data-act': 'cancel' })
        ])
      ])
    );
  }

  row.appendChild(el('p', { class: 'rule-msg', hidden: true, 'data-role': 'msg' }));
  return row;
}

/** Mostra erro ou aviso dentro da própria regra, sem redesenhar a lista. */
function showRuleMsg(row, text, kind) {
  const msg = row.querySelector('[data-role="msg"]');
  msg.textContent = text;
  msg.className = `rule-msg ${kind}`;
  msg.hidden = false;
}

// ---------------------------------------------------------------------------
// Configuração global
// ---------------------------------------------------------------------------

$('defaultAction').addEventListener('change', async (event) => {
  if (event.target.name !== 'defaultAction') return;
  await updateSettings({ defaultAction: event.target.value });
  // Redesenha para atualizar o rótulo "Padrão global (...)" de cada regra.
  await load();
});

$('notifyOnEnforce').addEventListener('change', async (event) => {
  await updateSettings({ notifyOnEnforce: event.target.checked });
});

$('enforceOnStartup').addEventListener('change', async (event) => {
  await updateSettings({ enforceOnStartup: event.target.checked });
});

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

$('rules').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;

  const row = button.closest('.rule');
  const id = row.dataset.id;
  const act = button.dataset.act;

  // Qualquer outro clique cancela uma exclusão pendente.
  if (act !== 'remove') state.confirmingId = null;

  if (act === 'up' || act === 'down') {
    await moveRule(id, act === 'up' ? -1 : 1);
    state.editingId = null;
    state.editDraft = null;
    await load();
    return;
  }

  if (act === 'edit') {
    // Abrir/fechar a edição, ou trocar de regra, descarta o rascunho anterior.
    state.editDraft = null;
    state.editingId = state.editingId === id ? null : id;
    renderRules();
    return;
  }

  if (act === 'cancel') {
    state.editDraft = null;
    state.editingId = null;
    renderRules();
    return;
  }

  if (act === 'save') {
    const result = await updateRule(id, {
      pattern: row.querySelector('[data-field="editPattern"]').value,
      label: row.querySelector('[data-field="editLabel"]').value
    });
    if (!result.ok) {
      showRuleMsg(row, result.error, 'error');
      return;
    }
    state.editDraft = null;
    state.editingId = null;
    await load();
    return;
  }

  if (act === 'remove') {
    // Duas etapas: o primeiro clique pede confirmação, o segundo exclui.
    if (state.confirmingId !== id) {
      state.confirmingId = id;
      renderRules();
      return;
    }
    state.confirmingId = null;
    state.editingId = null;
    state.editDraft = null;
    await removeRule(id);
    await load();
  }
});

$('rules').addEventListener('change', async (event) => {
  const field = event.target.dataset.field;
  if (!field) return;

  const row = event.target.closest('.rule');
  const id = row.dataset.id;
  const rule = state.config.rules.find((candidate) => candidate.id === id);
  if (!rule) return;

  if (field === 'limit') {
    const result = await updateRule(id, { limit: event.target.value });
    if (!result.ok) {
      showRuleMsg(row, result.error, 'error');
      event.target.value = String(rule.limit);
      return;
    }
    await load();
    return;
  }

  if (field === 'action') {
    const result = await updateRule(id, { action: event.target.value });
    if (!result.ok) {
      showRuleMsg(row, result.error, 'error');
      event.target.value = rule.action;
      return;
    }
    await load();
    return;
  }

  if (field === 'enabled') {
    await updateRule(id, { enabled: event.target.checked });
    await load();
  }
});

// ---------------------------------------------------------------------------
// Nova regra
// ---------------------------------------------------------------------------

$('addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('addError').hidden = true;
  $('addWarning').hidden = true;

  const result = await addRule({
    pattern: $('pattern').value,
    label: $('label').value,
    limit: $('limit').value,
    action: $('action').value
  });

  if (!result.ok) {
    $('addError').textContent = result.error;
    $('addError').hidden = false;
    return;
  }

  if (result.warning) {
    $('addWarning').textContent = result.warning;
    $('addWarning').hidden = false;
  }

  $('pattern').value = '';
  $('label').value = '';
  $('limit').value = '3';
  $('action').value = 'default';
  await load();
});

/** Sugestões de padrão a partir da aba ativa, para não digitar a URL à mão. */
async function renderSuggestions() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const suggestions = suggestPatterns(tab?.url ?? '');
  if (suggestions.length === 0) return;

  const box = $('suggestions');
  for (const { pattern, label } of suggestions) {
    box.appendChild(
      el('button', {
        type: 'button',
        text: label,
        title: pattern,
        onclick: () => {
          $('pattern').value = pattern;
          $('pattern').focus();
        }
      })
    );
  }
  box.hidden = false;
  $('pattern').value = suggestions[0].pattern;
}

// Sem este try, uma falha ao ler o storage deixaria o popup em branco e calado:
// o `await` no topo do módulo interrompe o script e nada mais é desenhado.
try {
  await load();
} catch (error) {
  const aviso = $('addError');
  aviso.textContent = `Não foi possível carregar as regras: ${error?.message ?? error}`;
  aviso.hidden = false;
}

// As sugestões são um extra: se falharem, o resto do popup continua utilizável.
try {
  await renderSuggestions();
} catch {
  // Sem sugestões o usuário ainda pode digitar o padrão à mão.
}
