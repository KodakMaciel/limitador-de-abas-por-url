// counter.js — contagem de abas por regra e badge do ícone.
//
// Não guarda estado: toda contagem parte de um chrome.tabs.query novo
// (regra 6 do CLAUDE.md). Somente janelas normais e não anônimas entram na
// conta (regra 10).

import { isSupportedUrl, normalizeUrl, patternToRegex } from './matcher.js';

/** Cor do badge quando ainda há folga no limite. */
const BADGE_COLOR_OK = '#0d47a1';

/** Cor do badge quando o limite já foi alcançado ou estourado. */
const BADGE_COLOR_FULL = '#c62828';

/**
 * URL que interessa para a aba: a de destino quando existe, senão a atual.
 *
 * Aba recém-criada tem `url` vazia e o endereço real em `pendingUrl`
 * (armadilha 1). Aba navegando tem as duas: `url` é de onde está saindo e
 * `pendingUrl` é para onde vai — e para um limitador o que importa é o destino.
 *
 * @param {chrome.tabs.Tab|undefined} tab
 * @returns {string}
 */
export function effectiveTabUrl(tab) {
  if (!tab) return '';
  const pending = typeof tab.pendingUrl === 'string' ? tab.pendingUrl : '';
  const current = typeof tab.url === 'string' ? tab.url : '';
  return pending !== '' ? pending : current;
}

/**
 * A aba já carregou algum endereço, ou acabou de nascer?
 *
 * Uma aba criada agora por ação do usuário chega com `url` vazia e o destino em
 * `pendingUrl` (armadilha 1). Já uma aba que nasce com `url` preenchida foi
 * restaurada (sessão anterior, Ctrl+Shift+T) ou duplicada — não é uma
 * navegação nova.
 * @param {chrome.tabs.Tab|undefined} tab
 * @returns {boolean}
 */
export function hasLoadedUrl(tab) {
  return typeof tab?.url === 'string' && tab.url !== '';
}

/**
 * A aba pode entrar na contagem de uma regra?
 * @param {chrome.tabs.Tab} tab
 * @returns {boolean}
 */
export function isCountableTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return false;
  if (tab.incognito === true) return false; // regra 10: anônimas ficam de fora
  return isSupportedUrl(effectiveTabUrl(tab));
}

/**
 * Todas as abas de janelas normais e não anônimas do perfil, sem filtrar por
 * URL — quem precisa da lista filtrada usa isCountableTab().
 * @returns {Promise<Array<chrome.tabs.Tab>>}
 */
export async function queryTabs() {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  return tabs.filter((tab) => tab.incognito !== true);
}

/**
 * Pré-compila as regras habilitadas, na ordem da lista. Compilar uma vez por
 * verificação evita recompilar a mesma RegExp para cada aba.
 * @param {Array<object>} rules
 * @returns {Array<{rule: object, regex: RegExp}>}
 */
export function compileRules(rules) {
  const compiled = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.enabled === false) continue;
    const regex = patternToRegex(rule.pattern);
    if (regex === null) continue;
    compiled.push({ rule, regex });
  }
  return compiled;
}

/**
 * Primeira regra compilada que casa com a URL — a ordem da lista é a
 * prioridade: a primeira que casar vence.
 * @param {string} rawUrl
 * @param {Array<{rule: object, regex: RegExp}>} compiled
 * @returns {{rule: object, regex: RegExp}|null}
 */
export function matchRuleFor(rawUrl, compiled) {
  const url = normalizeUrl(rawUrl);
  if (url === null) return null;
  for (const entry of compiled) {
    if (entry.regex.test(url)) return entry;
  }
  return null;
}

/**
 * Quantas abas cada regra tem abertas. Cada aba conta para UMA regra só — a
 * primeira que casar — para que os números somem e batam com o badge.
 * @param {Array<chrome.tabs.Tab>} tabs
 * @param {Array<{rule: object, regex: RegExp}>} compiled
 * @returns {Map<string, number>}
 */
export function countByRule(tabs, compiled) {
  const counts = new Map();
  for (const { rule } of compiled) counts.set(rule.id, 0);

  for (const tab of tabs) {
    if (!isCountableTab(tab)) continue;
    const match = matchRuleFor(effectiveTabUrl(tab), compiled);
    if (match) counts.set(match.rule.id, counts.get(match.rule.id) + 1);
  }
  return counts;
}

/**
 * Abas que já disputam a vaga com a aba analisada, isto é, todas as que contam
 * para a mesma regra e chegaram ANTES dela.
 *
 * O critério de "antes" depende de como a aba analisada entrou na regra:
 *
 * - `fromCreation` (veio de tabs.onCreated): a aba acabou de nascer, então
 *   TODA aba que já existia tem id menor que o dela. Abas com id maior são
 *   irmãs da mesma rajada (Ctrl+clique em série), criadas depois, e a
 *   verificação delas está atrás desta na fila. Descartá-las pelo id é exato
 *   e não depende do tempo de carregamento de ninguém.
 *
 * - caso contrário (navegou para dentro da regra): não há ordem de criação
 *   útil, porque a aba pode ser antiga e ainda assim ser a culpada pelo
 *   excesso (regra 8). O critério passa a ser o carregamento: uma aba mais
 *   nova que ainda não carregou nada acabou de ser criada e tem verificação
 *   própria atrás desta na fila.
 *
 * @param {Array<chrome.tabs.Tab>} tabs
 * @param {Array<{rule: object, regex: RegExp}>} compiled
 * @param {object} rule
 * @param {chrome.tabs.Tab} trigger
 * @param {{fromCreation?: boolean}} [options]
 * @returns {Array<chrome.tabs.Tab>}
 */
export function competingTabsFor(tabs, compiled, rule, trigger, { fromCreation = false } = {}) {
  return tabs.filter((tab) => {
    if (tab.id === trigger.id) return false;
    if (!isCountableTab(tab)) return false;
    if (fromCreation) {
      if (tab.id > trigger.id) return false;
    } else if (tab.id > trigger.id && !hasLoadedUrl(tab)) {
      return false;
    }
    const match = matchRuleFor(effectiveTabUrl(tab), compiled);
    return match !== null && match.rule.id === rule.id;
  });
}

// ---------------------------------------------------------------------------
// Foco de aba (usado pelo motor e pela página de aviso)
// ---------------------------------------------------------------------------

/**
 * Para qual aba já aberta levar o usuário: a usada mais recentemente, quando o
 * Chrome informa `lastAccessed`.
 * @param {Array<chrome.tabs.Tab>} candidates
 * @param {number} [preferredWindowId] janela a privilegiar; sem ela, considera
 *   todas as candidatas
 * @returns {chrome.tabs.Tab|null}
 */
export function pickTabToFocus(candidates, preferredWindowId) {
  const sameWindow =
    preferredWindowId === undefined
      ? []
      : candidates.filter((tab) => tab.windowId === preferredWindowId);
  const pool = sameWindow.length > 0 ? sameWindow : candidates;
  if (pool.length === 0) return null;
  return pool.reduce(
    (best, tab) => ((tab.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? tab : best),
    pool[0]
  );
}

/**
 * Armadilha 8: focar uma aba exige ativar a aba E focar a janela dela — uma
 * chamada só deixa a aba ativa numa janela que continua atrás das outras.
 * @param {chrome.tabs.Tab} tab
 */
export async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/**
 * Texto do badge. Uma função só para que o motor e o popup nunca divirjam no
 * formato mostrado para a mesma regra.
 * @param {number} count
 * @param {number} limit
 * @returns {string}
 */
export function formatBadgeText(count, limit) {
  return `${count}/${limit}`;
}

/** Cor de fundo padrão do badge, aplicada uma vez na instalação/inicialização. */
export async function applyBadgeColor() {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OK });
}

/**
 * Escreve `n/limite` no badge de uma aba específica. Por aba, e não global,
 * para ficar correto mesmo com várias janelas abertas.
 * @param {number} tabId
 * @param {string} text
 * @param {boolean} atLimit
 */
export async function setTabBadge(tabId, text, atLimit) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: atLimit ? BADGE_COLOR_FULL : BADGE_COLOR_OK
    });
  } catch {
    // A aba pode ter sido fechada entre a contagem e a escrita do badge.
  }
}

/** Apaga o badge de uma aba. */
export async function clearTabBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // Idem: aba já fechada.
  }
}
