// background.js — service worker: listeners e motor de enforcement.
//
// Regras estruturais que este arquivo obedece (CLAUDE.md):
//   5. Todos os listeners são registrados no nível superior deste módulo. Um
//      listener registrado depois de um `await` não sobreviveria ao worker
//      dormir.
//   6. Nada em memória é fonte da verdade: cada verificação relê as regras do
//      storage e reconta as abas com chrome.tabs.query.
//   7. Toda verificação passa por uma fila serializada — uma por vez.
//   8. A aba impedida é sempre a que causou o excesso, nunca uma aba antiga.
//  12. Sem log ruidoso: só atrás do sinalizador DEBUG.
//
// Sem polling: nenhum setInterval, setTimeout recorrente ou chrome.alarms.

import {
  actionClosesTab,
  actionFocusesExistingTab,
  ensureConfig,
  getConfig,
  resolveAction
} from './lib/storage.js';
import {
  applyBadgeColor,
  clearTabBadge,
  compileRules,
  competingTabsFor,
  countByRule,
  effectiveTabUrl,
  focusTab,
  formatBadgeText,
  hasLoadedUrl,
  isCountableTab,
  matchRuleFor,
  pickTabToFocus,
  queryTabs,
  setTabBadge
} from './lib/counter.js';

const DEBUG = false;

const BLOCKED_PAGE = 'src/blocked/blocked.html';

function log(...args) {
  if (DEBUG) console.log('[limitador]', ...args);
}

// ---------------------------------------------------------------------------
// Fila serializada (regra 7)
// ---------------------------------------------------------------------------

// Uma verificação por vez. Sem isso, dez abas abertas de uma vez fariam dez
// contagens simultâneas em cima do mesmo estado e todas passariam pelo limite.
let queue = Promise.resolve();

function enqueue(task) {
  queue = queue.then(task).catch((error) => log('falha na tarefa', error));
  return queue;
}

// ---------------------------------------------------------------------------
// Verificação de limite
// ---------------------------------------------------------------------------

/**
 * Relê as regras, reconta as abas e decide se a aba informada passa do limite.
 * @param {number} tabId aba que acabou de ser criada ou de navegar
 * @param {{canClose: boolean}} options `canClose` só vale para abas que acabaram
 *   de nascer. Uma aba que o usuário já tinha e que apenas navegou para dentro
 *   da regra jamais é fechada (regra 8): ela recebe a página de aviso. Fechá-la
 *   sumiria com uma aba em uso — e, se fosse a única da janela, com a janela.
 */
async function checkTab(tabId, { canClose }) {
  const config = await getConfig();
  const compiled = compileRules(config.rules);
  if (compiled.length === 0) return;

  const tabs = await queryTabs();
  // Aba não encontrada: já foi fechada, ou é anônima / de janela não normal.
  const trigger = tabs.find((tab) => tab.id === tabId);
  if (!trigger) return;

  const match = isCountableTab(trigger)
    ? matchRuleFor(effectiveTabUrl(trigger), compiled)
    : null;

  if (!match) {
    // A aba saiu do escopo das regras — mudou de site ou foi para chrome://.
    // Apaga o badge dela e corrige a contagem das que ficaram, reaproveitando
    // a consulta já feita em vez de consultar o navegador de novo.
    await clearTabBadge(tabId);
    await applyBadges(tabs, compiled, { clearUnmatched: false });
    return;
  }

  // `canClose` é verdadeiro exatamente quando o evento foi tabs.onCreated, que
  // é também a informação de que a aba acabou de nascer.
  const competing = competingTabsFor(tabs, compiled, match.rule, trigger, {
    fromCreation: canClose
  });

  // Ainda cabe: contando esta aba dá no máximo o limite.
  if (competing.length < match.rule.limit) {
    // O badge das outras abas da regra também muda, porque a contagem subiu.
    // Sem isso elas ficariam com o número velho até serem reativadas — e
    // trocar de janela não dispara onActivated.
    const total = competing.length + 1;
    const text = formatBadgeText(total, match.rule.limit);
    const atLimit = total >= match.rule.limit;
    await Promise.all([
      setTabBadge(trigger.id, text, atLimit),
      ...competing.map((tab) => setTabBadge(tab.id, text, atLimit))
    ]);
    return;
  }

  log('limite atingido', match.rule.pattern, competing.length, match.rule.limit);
  try {
    await enforce(config, match.rule, trigger, tabs, competing, { canClose });
  } finally {
    // Mesmo se fechar ou navegar falhar — a aba pode ter sumido no meio do
    // caminho — os badges precisam terminar refletindo a contagem real.
    // Reaproveita `compiled`: as regras não mudaram durante a aplicação da
    // ação, então reler o storage aqui seria uma ida a mais sem ganho.
    await applyBadges(await queryTabs(), compiled, { clearUnmatched: true });
  }
}

/**
 * Aplica a ação da regra à aba que causou o excesso.
 * @param {object} config
 * @param {object} rule
 * @param {chrome.tabs.Tab} trigger
 * @param {Array<chrome.tabs.Tab>} tabs todas as abas contáveis do perfil
 * @param {Array<chrome.tabs.Tab>} competing abas que já ocupavam as vagas
 * @param {{canClose: boolean}} options ver checkTab
 * @returns {Promise<boolean>} true se a aba foi realmente fechada — quem chama
 *   em loop (enforceRestoredTabs) precisa disso para manter a contagem de abas
 *   por janela correta ao longo das várias chamadas.
 */
async function enforce(config, rule, trigger, tabs, competing, { canClose }) {
  const action = resolveAction(rule, config.settings);

  if (action === 'notify') {
    // 'notify' não mexe em aba nenhuma: o aviso É a ação, então sai sempre.
    await notifyLimit(rule, competing.length);
    return false;
  }

  // A aba é preservada (recebe a página de aviso) em três situações:
  //   - a ação escolhida não fecha aba ('block');
  //   - a aba não é nova, então o usuário já estava usando ela (regra 8);
  //   - é a única aba da janela, e fechá-la fecharia a janela (armadilha 5).
  const mayClose = actionClosesTab(action) && canClose && hasOtherTabsInWindow(tabs, trigger);
  let removed = false;

  if (mayClose) {
    // 'close' leva o usuário até uma aba que já ocupa a vaga; 'closeQuiet'
    // fecha e não tira o usuário do lugar. Focar antes de fechar evita o
    // piscar de uma aba intermediária — mas focar é conveniência e o
    // fechamento é a regra: se a aba escolhida sumiu entre a consulta e agora,
    // o erro não pode cancelar o fechamento, senão o limite seria furado em
    // silêncio.
    if (actionFocusesExistingTab(action)) {
      const target = pickTabToFocus(competing, trigger.windowId);
      if (target) {
        try {
          await focusTab(target);
        } catch (error) {
          log('não foi possível focar a aba existente', error);
        }
      }
    }

    // Reconfere a janela agora: entre a contagem lá em cima e este ponto houve
    // awaits, e a aba irmã pode ter sido fechada nesse intervalo. Fechar sem
    // reconferir levaria a janela do usuário junto (armadilha 5).
    if (hasOtherTabsInWindow(await queryTabs(), trigger)) {
      await chrome.tabs.remove(trigger.id);
      removed = true;
    }
  }

  if (!removed) {
    await chrome.tabs.update(trigger.id, { url: blockedPageUrl(rule, competing.length, trigger) });
  }

  if (config.settings.notifyOnEnforce) {
    await notifyLimit(rule, competing.length);
  }

  return removed;
}

/** A janela da aba informada tem alguma OUTRA aba além dela? */
function hasOtherTabsInWindow(tabs, trigger) {
  return tabs.some((tab) => tab.windowId === trigger.windowId && tab.id !== trigger.id);
}

/**
 * URL da página de aviso, com o contexto da regra. A página em si é da Etapa 5;
 * aqui o motor apenas entrega os dados que ela vai exibir.
 */
function blockedPageUrl(rule, existingCount, trigger) {
  const params = new URLSearchParams({
    ruleId: rule.id,
    pattern: rule.pattern,
    label: rule.label ?? '',
    limit: String(rule.limit),
    count: String(existingCount),
    url: effectiveTabUrl(trigger)
  });
  return `${chrome.runtime.getURL(BLOCKED_PAGE)}?${params.toString()}`;
}

/**
 * Aviso do sistema. O id é fixo por regra, então uma rajada de dez abas
 * substitui o mesmo aviso em vez de empilhar dez.
 */
async function notifyLimit(rule, existingCount) {
  const name = rule.label || rule.pattern;
  try {
    await chrome.notifications.create(`limit:${rule.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'), // armadilha 7
      title: 'Limite de abas atingido',
      message: `${name}\n${existingCount} de ${rule.limit} aba(s) já abertas.`,
      priority: 0
    });
  } catch (error) {
    log('não foi possível criar o aviso', error);
  }
}

/**
 * Clique no aviso: leva o usuário a uma das abas que ocupam as vagas da regra.
 * @param {string} notificationId no formato `limit:<id da regra>`
 */
async function focusRuleTab(notificationId) {
  const prefix = 'limit:';
  if (!notificationId.startsWith(prefix)) return;

  try {
    await chrome.notifications.clear(notificationId);
  } catch (error) {
    log('não foi possível fechar o aviso', error);
  }

  const ruleId = notificationId.slice(prefix.length);
  const config = await getConfig();
  if (!config.rules.some((candidate) => candidate.id === ruleId)) {
    return; // a regra foi apagada enquanto o aviso estava na tela
  }

  // Compila a lista INTEIRA e filtra pelo id da regra, em vez de compilar só
  // esta regra: uma aba pode casar com o padrão dela e ainda assim contar para
  // outra regra que vem antes na lista ("a primeira que casar vence"). Compilar
  // isolado levaria o usuário a uma aba que não ocupa vaga desta regra.
  const compiled = compileRules(config.rules);
  if (compiled.length === 0) return;

  const tabs = await queryTabs();
  const candidates = tabs.filter((tab) => {
    if (!isCountableTab(tab)) return false;
    const match = matchRuleFor(effectiveTabUrl(tab), compiled);
    return match !== null && match.rule.id === ruleId;
  });

  const target = pickTabToFocus(candidates);
  if (target) await focusTab(target);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/**
 * Recalcula o badge de uma aba só. Usado quando o usuário troca de aba.
 * @param {number} tabId
 */
async function refreshBadgeForTab(tabId) {
  const config = await getConfig();
  const compiled = compileRules(config.rules);
  // Sem nenhuma regra ativa não há badge a mostrar, e o que existia já foi
  // apagado quando a última regra saiu (via storage.onChanged). Este atalho
  // evita consultar as abas a cada troca de aba de quem não usa regra nenhuma.
  if (compiled.length === 0) return;

  const tabs = await queryTabs();

  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;

  const match = isCountableTab(tab) ? matchRuleFor(effectiveTabUrl(tab), compiled) : null;
  if (!match) {
    await clearTabBadge(tabId);
    return;
  }

  const count = countByRule(tabs, compiled).get(match.rule.id) ?? 0;
  await setTabBadge(tabId, formatBadgeText(count, match.rule.limit), count >= match.rule.limit);
}

/**
 * Recalcula os badges das abas.
 * @param {{clearUnmatched: boolean}} options quando `clearUnmatched` é falso,
 *   só as abas que casam com alguma regra são atualizadas. Fechar uma aba muda
 *   as contagens mas não muda quem casa com o quê, então não há o que apagar —
 *   e assim fechar vinte abas não gera trabalho para todas as abas do perfil.
 */
async function refreshBadges({ clearUnmatched }) {
  const config = await getConfig();
  const compiled = compileRules(config.rules);
  if (compiled.length === 0 && !clearUnmatched) return;
  await applyBadges(await queryTabs(), compiled, { clearUnmatched });
}

/**
 * Escreve os badges a partir de uma lista de abas já consultada, para quem já
 * pagou o custo da consulta não pagar de novo.
 * @param {Array<chrome.tabs.Tab>} tabs
 * @param {Array<{rule: object, regex: RegExp}>} compiled
 * @param {{clearUnmatched: boolean}} options
 */
async function applyBadges(tabs, compiled, { clearUnmatched }) {
  const counts = countByRule(tabs, compiled);

  await Promise.all(
    tabs.map((tab) => {
      const match = isCountableTab(tab) ? matchRuleFor(effectiveTabUrl(tab), compiled) : null;
      if (match) {
        const count = counts.get(match.rule.id) ?? 0;
        return setTabBadge(
          tab.id,
          formatBadgeText(count, match.rule.limit),
          count >= match.rule.limit
        );
      }
      return clearUnmatched ? clearTabBadge(tab.id) : Promise.resolve();
    })
  );
}

// ---------------------------------------------------------------------------
// Restauração de sessão
// ---------------------------------------------------------------------------

/**
 * Aplica os limites às abas restauradas. Só roda quando o usuário liga
 * `enforceOnStartup` — por padrão a inicialização apenas reconta.
 *
 * Aqui todas as abas já carregaram, então a ordem de chegada é a ordem dos ids:
 * as `limit` primeiras ficam e o excedente é tratado. Assim as abas mais
 * antigas nunca são sacrificadas.
 */
async function enforceRestoredTabs(config) {
  const compiled = compileRules(config.rules);
  if (compiled.length === 0) return;

  const tabs = await queryTabs();
  const byRule = new Map();

  for (const tab of [...tabs].sort((a, b) => a.id - b.id)) {
    if (!isCountableTab(tab)) continue;
    const match = matchRuleFor(effectiveTabUrl(tab), compiled);
    if (!match) continue;
    if (!byRule.has(match.rule.id)) byRule.set(match.rule.id, { rule: match.rule, tabs: [] });
    byRule.get(match.rule.id).tabs.push(tab);
  }

  // Cópia que encolhe a cada aba realmente fechada. Regras diferentes podem
  // ter excesso na mesma janela — sem atualizar isto, a segunda chamada a
  // enforce() ainda "veria" a aba que a primeira chamada já fechou e
  // concluiria, errado, que a janela tem mais de uma aba (armadilha 5).
  let liveTabs = tabs;

  for (const { rule, tabs: ruleTabs } of byRule.values()) {
    const kept = ruleTabs.slice(0, rule.limit);
    for (const excess of ruleTabs.slice(rule.limit)) {
      log('excesso restaurado', rule.pattern, excess.id);
      try {
        // Aqui fechar é permitido: o usuário ligou enforceOnStartup de propósito.
        const removed = await enforce(config, rule, excess, liveTabs, kept, { canClose: true });
        if (removed) liveTabs = liveTabs.filter((tab) => tab.id !== excess.id);
      } catch (error) {
        // Uma aba que sumiu no meio da varredura não pode abortar as demais:
        // sem isto, a primeira falha deixaria todo o resto do excesso intocado.
        log('falha ao tratar excesso restaurado', excess.id, error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Listeners — todos no nível superior (regra 5)
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  enqueue(async () => {
    await ensureConfig();
    await applyBadgeColor();
    await refreshBadges({ clearUnmatched: true });
  });
});

chrome.runtime.onStartup.addListener(() => {
  enqueue(async () => {
    await applyBadgeColor();
    const config = await getConfig();
    // Decisão do projeto: abas restauradas não são fechadas, apenas recontadas.
    if (config.settings.enforceOnStartup) await enforceRestoredTabs(config);
    await refreshBadges({ clearUnmatched: true });
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  // Armadilha 1: aqui a URL real está em pendingUrl. Verificar já no onCreated
  // impede a aba antes de a página carregar — o portal nem cria sessão.
  // É a única origem em que fechar a aba é permitido: ela acabou de nascer.
  if (typeof tab?.id !== 'number') return;

  // Uma aba que JÁ nasce com `url` preenchida não é navegação nova: é aba
  // restaurada ou duplicada. E o Chrome dispara onCreated para CADA aba de
  // sessão restaurada — sem esta guarda, reabrir o navegador com mais abas do
  // que o limite fecharia as excedentes, contra a decisão de projeto e o
  // critério de aceitação de que a restauração apenas reconta. Restaurada não
  // é tocada aqui de forma alguma (nem fechada, nem levada ao aviso); se ela
  // navegar depois, onUpdated aplica o limite normalmente.
  if (hasLoadedUrl(tab)) {
    enqueue(() => refreshBadges({ clearUnmatched: false }));
    return;
  }

  enqueue(() => checkTab(tab.id, { canClose: true }));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Armadilha 2: o Chrome não aceita filtro em tabs.onUpdated (é extensão do
  // Firefox e faria addListener lançar), então o filtro fica na primeira linha.
  if (!changeInfo.url) return;
  enqueue(() => checkTab(tabId, { canClose: false }));
});

chrome.tabs.onReplaced.addListener((addedTabId) => {
  // O Chrome troca a aba por outra (id novo) em pré-renderização e navegação
  // instantânea. Sem isto, uma aba entraria na regra sem nunca ser contada,
  // porque nem onCreated nem onUpdated disparam para a aba que assume o lugar.
  enqueue(() => checkTab(addedTabId, { canClose: false }));
});

chrome.tabs.onRemoved.addListener(() => {
  // Fechar uma aba libera vaga: só as contagens mudam.
  enqueue(() => refreshBadges({ clearUnmatched: false }));
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  enqueue(() => refreshBadgeForTab(tabId));
});

chrome.notifications.onClicked.addListener((notificationId) => {
  enqueue(() => focusRuleTab(notificationId));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  // Regras alteradas na interface: quem casa com o quê muda, então os badges
  // das abas que deixaram de casar precisam ser apagados.
  if (areaName !== 'local' || !changes.config) return;
  enqueue(() => refreshBadges({ clearUnmatched: true }));
});
