// blocked.js — pagina mostrada quando a acao da regra e 'block'.
//
// O contexto vem nos parametros da URL, montados por background.js. Tudo e
// escrito com textContent: o padrao e a URL sao texto do usuario e a URL
// impedida NUNCA vira href (um 'javascript:' ali seria clicavel).

import {
  compileRules,
  effectiveTabUrl,
  focusTab,
  isCountableTab,
  matchRuleFor,
  pickTabToFocus,
  queryTabs
} from '../lib/counter.js';
import { getConfig } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const ruleId = params.get('ruleId') ?? '';
const pattern = params.get('pattern') ?? '';
const label = params.get('label') ?? '';
const limit = params.get('limit') ?? '';
const blockedUrl = params.get('url') ?? '';

/** Preenche o painel de detalhes com o que veio na URL. */
function renderDetail() {
  if (pattern === '') return; // pagina aberta direto, sem contexto

  $('ruleName').textContent = label !== '' ? label : '(sem nome)';
  $('rulePattern').textContent = pattern;
  $('ruleLimit').textContent =
    limit === '' ? '—' : `${limit} ${limit === '1' ? 'aba' : 'abas'} ao mesmo tempo`;

  if (blockedUrl !== '') {
    $('blockedUrl').textContent = blockedUrl;
    $('urlRow').hidden = false;
  }

  $('detail').hidden = false;
  $('lead').textContent =
    'Esta aba foi impedida porque o limite deste endereço já estava completo.';
}

/**
 * Abas que ocupam as vagas da MESMA regra que bloqueou esta aba, exceto esta.
 *
 * Casa pela regra (via ruleId), não pelo padrão isolado: se houver uma regra
 * mais específica na frente desta no storage, uma aba pode casar com o
 * padrão desta página e ainda assim contar para a outra regra — o motor em
 * background.js decide por "a primeira que casar vence" (compileRules() +
 * matchRuleFor()), e é esse mesmo critério que precisa valer aqui.
 */
async function findOpenTabs() {
  if (ruleId === '') return [];

  const config = await getConfig();
  const rule = config.rules.find((candidate) => candidate.id === ruleId);
  if (!rule) return []; // a regra foi apagada enquanto a página estava aberta

  const compiled = compileRules(config.rules);
  const self = await chrome.tabs.getCurrent();
  const tabs = await queryTabs();

  return tabs.filter((tab) => {
    if (tab.id === self?.id) return false;
    if (!isCountableTab(tab)) return false;
    const match = matchRuleFor(effectiveTabUrl(tab), compiled);
    return match !== null && match.rule.id === ruleId;
  });
}

/** Fecha esta aba, exceto se for a última da janela (armadilha 5). */
async function closeSelf() {
  const self = await chrome.tabs.getCurrent();
  if (!self) return;

  const tabs = await queryTabs();
  const siblings = tabs.filter((tab) => tab.windowId === self.windowId).length;
  if (siblings > 1) await chrome.tabs.remove(self.id);
  // Se for a única aba da janela, não fecha: fechá-la fecharia a janela do
  // usuário, e ele só pediu para fechar a aba.
}

/**
 * Foca uma aba que ocupa vaga da regra e, se possível, fecha esta.
 * Reconsulta as abas na hora do clique — a lista calculada em setUp() pode
 * estar obsoleta se o usuário fechou a aba-alvo por fora enquanto a página
 * de aviso ficava aberta.
 */
async function goToOpenTab() {
  const open = await findOpenTabs();
  const target = pickTabToFocus(open);
  if (!target) return; // nenhuma candidata sobrou; não há para onde ir

  try {
    await focusTab(target);
  } catch {
    return; // a aba escolhida sumiu entre a consulta e o foco; nada a fazer
  }

  await closeSelf();
}

async function setUp() {
  renderDetail();

  // "Voltar" so aparece quando ha para onde voltar: uma aba recem-criada e
  // impedida antes de carregar qualquer coisa, e ai o historico esta vazio.
  if (history.length > 1) {
    $('goBack').hidden = false;
    $('goBack').addEventListener('click', () => history.back());
  }

  $('closeTab').addEventListener('click', () => {
    closeSelf();
  });

  const open = await findOpenTabs();
  if (open.length === 0) return;

  const button = $('goToTab');
  button.hidden = false;
  button.textContent =
    open.length === 1 ? 'Ir para a aba já aberta' : `Ir para uma das ${open.length} abas abertas`;
  button.addEventListener('click', goToOpenTab);
}

await setUp();
