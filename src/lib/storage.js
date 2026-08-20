// storage.js — schema, defaults, CRUD de regras e migração.
//
// Camada fina e SEM ESTADO sobre chrome.storage.local: nenhum cache é fonte da
// verdade (regra 6 do CLAUDE.md), toda leitura vai ao storage. O único estado
// em memória é a fila que serializa as escritas, para que duas alterações
// simultâneas não sobrescrevam uma à outra (leitura-modificação-escrita).
//
// Alcance da fila: ela é estado de MÓDULO, então serializa apenas dentro de um
// mesmo contexto de execução. O service worker e o popup carregam instâncias
// separadas deste módulo e têm filas independentes — chrome.storage.local não
// oferece compare-and-swap, então não há como serializar entre contextos aqui.
// Na prática isso não é alcançável nesta extensão: o popup é a única origem de
// escritas de regras (e o Chrome mantém no máximo um popup aberto), enquanto o
// service worker só escreve em ensureConfig(), no onInstalled/onStartup, quando
// nenhum popup pode estar aberto. Um dia em que o worker passe a escrever
// regras, isto precisa virar uma escrita única roteada por mensagem.

import { normalizePattern, validatePattern } from './matcher.js';

const DEBUG = false;

const STORAGE_KEY = 'config';

/** Versão do schema. Alterar exige escrever a migração em migrateConfig(). */
export const SCHEMA_VERSION = 1;

/**
 * Ações possíveis para a configuração global.
 *
 * `close` e `closeQuiet` fecham a aba que estourou o limite; a diferença é que
 * `close` ainda leva o usuário até uma aba que já ocupa a vaga, e `closeQuiet`
 * deixa o usuário exatamente onde estava.
 *
 * Acrescentar um valor aqui NÃO exige migração nem bump de SCHEMA_VERSION:
 * nenhum campo novo entra no schema, e uma configuração gravada antes continua
 * válida (o valor antigo dela segue na lista).
 */
export const GLOBAL_ACTIONS = ['close', 'closeQuiet', 'block', 'notify'];

/** Ações possíveis por regra ('default' delega à configuração global). */
export const RULE_ACTIONS = ['default', ...GLOBAL_ACTIONS];

/** Ações que fecham a aba que causou o excesso. */
const CLOSING_ACTIONS = ['close', 'closeQuiet'];

/** Ações que, além de fechar, levam o usuário a uma aba que já ocupa a vaga. */
const FOCUSING_ACTIONS = ['close'];

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 99;
export const MAX_LABEL_LENGTH = 60;

const RULE_FIELDS = ['pattern', 'label', 'limit', 'action', 'enabled'];

function log(...args) {
  if (DEBUG) console.log('[storage]', ...args);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** @returns {{defaultAction: string, notifyOnEnforce: boolean, enforceOnStartup: boolean}} */
export function defaultSettings() {
  return {
    defaultAction: 'close',
    notifyOnEnforce: true,
    enforceOnStartup: false
  };
}

/** Sempre devolve um objeto novo — nunca uma constante compartilhada. */
export function defaultConfig() {
  return {
    version: SCHEMA_VERSION,
    settings: defaultSettings(),
    rules: []
  };
}

// ---------------------------------------------------------------------------
// Validação de entrada do usuário (regra 13)
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {{valid: boolean, error: string|null, value: number|null}}
 */
export function validateLimit(value) {
  const invalid = (error) => ({ valid: false, error, value: null });

  if (typeof value === 'string' && value.trim() === '') {
    return invalid(`Informe um número inteiro entre ${LIMIT_MIN} e ${LIMIT_MAX}.`);
  }
  // Só inteiro DECIMAL. Number() aceitaria '0x63' (99), '0b11' (3) e '1e1'
  // (10), que não são o que "número inteiro" quer dizer para quem digita.
  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) {
    return invalid(`Informe um número inteiro entre ${LIMIT_MIN} e ${LIMIT_MAX}.`);
  }
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    return invalid(`Informe um número inteiro entre ${LIMIT_MIN} e ${LIMIT_MAX}.`);
  }
  if (parsed < LIMIT_MIN || parsed > LIMIT_MAX) {
    return invalid(`O limite deve ficar entre ${LIMIT_MIN} e ${LIMIT_MAX}.`);
  }
  return { valid: true, error: null, value: parsed };
}

/**
 * Valida uma regra candidata contra as regras já existentes.
 * @param {unknown} candidate campos da regra vindos da interface
 * @param {Array<object>} existingRules regras já gravadas
 * @param {string|null} ignoreId id a desconsiderar na checagem de duplicidade
 *   (usado na edição, para a regra não conflitar consigo mesma)
 * @returns {{valid: boolean, error: string|null, warning: string|null, fields: object|null}}
 */
export function validateRule(candidate, existingRules = [], ignoreId = null) {
  const invalid = (error) => ({ valid: false, error, warning: null, fields: null });

  const source = isObject(candidate) ? candidate : {};

  const patternCheck = validatePattern(source.pattern);
  if (!patternCheck.valid) return invalid(patternCheck.error);

  const limitCheck = validateLimit(source.limit);
  if (!limitCheck.valid) return invalid(limitCheck.error);

  const action = source.action === undefined ? 'default' : source.action;
  if (!RULE_ACTIONS.includes(action)) {
    return invalid('Ação inválida para a regra.');
  }

  const rules = Array.isArray(existingRules) ? existingRules : [];
  const duplicate = rules.find(
    (rule) =>
      isObject(rule) &&
      rule.id !== ignoreId &&
      normalizePattern(rule.pattern) === patternCheck.normalized
  );
  if (duplicate) {
    const which = duplicate.label ? ` ("${duplicate.label}")` : '';
    return invalid(`Já existe uma regra com este padrão${which}. Edite a regra existente.`);
  }

  return {
    valid: true,
    error: null,
    warning: patternCheck.warning,
    fields: {
      pattern: patternCheck.normalized,
      label: sanitizeLabel(source.label),
      limit: limitCheck.value,
      action,
      enabled: source.enabled === undefined ? true : Boolean(source.enabled)
    }
  };
}

/**
 * A ação fecha a aba que causou o excesso?
 *
 * Deliberadamente uma lista POSITIVA. A checagem que existia antes era
 * `action !== 'block'`, e com ela qualquer ação nova passaria a fechar aba por
 * omissão — o default mais destrutivo possível para quem esquecer de atualizar
 * o motor.
 * @param {string} action ação já resolvida (nunca 'default')
 * @returns {boolean}
 */
export function actionClosesTab(action) {
  return CLOSING_ACTIONS.includes(action);
}

/**
 * A ação, além de fechar, leva o usuário até uma aba que já ocupa a vaga?
 * É o único ponto em que 'close' e 'closeQuiet' divergem.
 * @param {string} action ação já resolvida (nunca 'default')
 * @returns {boolean}
 */
export function actionFocusesExistingTab(action) {
  return FOCUSING_ACTIONS.includes(action);
}

/** Ação efetiva de uma regra: 'default' delega à configuração global. */
export function resolveAction(rule, settings) {
  const fallback = GLOBAL_ACTIONS.includes(settings?.defaultAction)
    ? settings.defaultAction
    : defaultSettings().defaultAction;
  const action = rule?.action;
  return GLOBAL_ACTIONS.includes(action) ? action : fallback;
}

// ---------------------------------------------------------------------------
// Saneamento e migração (funções puras — testáveis sem o Chrome)
// ---------------------------------------------------------------------------

function sanitizeLabel(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Conserta um limite gravado fora da faixa, em vez de descartar a regra.
 * @returns {{limit: number, usable: boolean}} `usable` é falso quando não havia
 *   número aproveitável nenhum: nesse caso não se pode inventar um limite e
 *   começar a fechar abas por conta própria — quem chama desativa a regra.
 */
function clampLimit(value) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return { limit: LIMIT_MIN, usable: false };
  return { limit: Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, parsed)), usable: true };
}

/**
 * Id para uma regra gravada sem id. Tem de ser DERIVADO do padrão, nunca
 * sorteado: getConfig() é leitura pura e roda a cada operação, então um id
 * aleatório aqui mudaria a cada chamada — a interface mostraria um id e o
 * storage já teria outro, e a regra ficaria impossível de editar ou apagar
 * ("Regra não encontrada" para sempre). Os padrões são únicos dentro da lista
 * (sanitizeConfig descarta duplicados), então servem de chave estável.
 */
function derivedRuleId(pattern) {
  return `pattern:${pattern}`;
}

function sanitizeRule(raw) {
  if (!isObject(raw)) return null;
  const pattern = normalizePattern(raw.pattern);
  // Sem um padrão utilizável não há nada para aplicar: a regra é descartada.
  if (pattern === null) return null;
  const { limit, usable } = clampLimit(raw.limit);
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : derivedRuleId(pattern),
    pattern,
    label: sanitizeLabel(raw.label),
    limit,
    action: RULE_ACTIONS.includes(raw.action) ? raw.action : 'default',
    // Sem limite aproveitável a regra fica DESATIVADA em vez de assumir o
    // limite mínimo: assumir 1 seria a leitura mais agressiva possível e
    // começaria a fechar a segunda aba do site sem o usuário ter pedido nada.
    // Desativada, ela aparece na interface para ser corrigida e não age.
    enabled: raw.enabled !== false && usable,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  };
}

/**
 * Devolve uma configuração que obedece ao schema, consertando o que dá para
 * consertar e descartando o que é irrecuperável. Nunca lança.
 * @param {unknown} raw
 * @returns {object}
 */
export function sanitizeConfig(raw) {
  const base = defaultConfig();
  if (!isObject(raw)) return base;

  const settings = isObject(raw.settings) ? raw.settings : {};
  const sanitized = {
    // A saída desta função obedece, por construção, ao schema ATUAL — então ela
    // é rotulada com a versão atual. Preservar um número maior seria mentir:
    // campos que esta versão não conhece já foram descartados aqui, e uma
    // versão futura, ao reler, acharia que já migrou e não migraria de novo.
    version: SCHEMA_VERSION,
    settings: {
      defaultAction: GLOBAL_ACTIONS.includes(settings.defaultAction)
        ? settings.defaultAction
        : base.settings.defaultAction,
      notifyOnEnforce:
        typeof settings.notifyOnEnforce === 'boolean'
          ? settings.notifyOnEnforce
          : base.settings.notifyOnEnforce,
      enforceOnStartup:
        typeof settings.enforceOnStartup === 'boolean'
          ? settings.enforceOnStartup
          : base.settings.enforceOnStartup
    },
    rules: []
  };

  const seenPatterns = new Set();
  for (const rawRule of Array.isArray(raw.rules) ? raw.rules : []) {
    const rule = sanitizeRule(rawRule);
    if (rule === null) {
      log('regra descartada (padrão inutilizável)', rawRule);
      continue;
    }
    if (seenPatterns.has(rule.pattern)) {
      log('regra descartada (padrão duplicado)', rule.pattern);
      continue;
    }
    seenPatterns.add(rule.pattern);
    sanitized.rules.push(rule);
  }

  return sanitized;
}

/**
 * Traz uma configuração gravada para o schema atual.
 * @param {unknown} stored valor cru lido do storage
 * @returns {object}
 */
export function migrateConfig(stored) {
  // Instalação nova ou dado corrompido: começa dos defaults.
  if (!isObject(stored)) return defaultConfig();

  const working = { ...stored };

  // v0 -> v1: gravações anteriores ao campo 'version'. O `< 1` importa: `0` é
  // inteiro e sem ele passaria batido, deixando a configuração marcada como v0
  // para sempre — e qualquer migração futura escrita como `version === 1`
  // nunca a alcançaria.
  if (!Number.isInteger(working.version) || working.version < 1) {
    working.version = 1;
  }

  // Próximas migrações entram aqui, uma por versão:
  // if (working.version === 1) { /* transformar */ working.version = 2; }

  if (working.version > SCHEMA_VERSION) {
    log('configuração gravada por uma versão mais nova do schema', working.version);
  }

  return sanitizeConfig(working);
}

// ---------------------------------------------------------------------------
// Acesso ao storage
// ---------------------------------------------------------------------------

function storageArea() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    throw new Error('chrome.storage.local indisponível neste contexto.');
  }
  return chrome.storage.local;
}

// Fila de escrita: garante uma leitura-modificação-escrita por vez.
let writeQueue = Promise.resolve();

function serialize(task) {
  const result = writeQueue.then(() => task());
  // A fila nunca guarda uma rejeição, senão travaria todas as escritas seguintes.
  writeQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function readStored() {
  const data = await storageArea().get(STORAGE_KEY);
  return isObject(data) ? data[STORAGE_KEY] : undefined;
}

async function writeConfig(config) {
  const sanitized = sanitizeConfig(config);
  await storageArea().set({ [STORAGE_KEY]: sanitized });
  return sanitized;
}

/**
 * Lê a configuração atual, migrada e saneada. Não escreve nada.
 * @returns {Promise<object>}
 */
export async function getConfig() {
  return migrateConfig(await readStored());
}

/**
 * Grava a configuração inteira (sobrescreve).
 * @param {object} config
 * @returns {Promise<object>} a configuração como ficou gravada
 */
export async function saveConfig(config) {
  return serialize(() => writeConfig(config));
}

/**
 * Grava os defaults se ainda não houver nada, ou persiste o resultado de uma
 * migração. Deve ser chamada em chrome.runtime.onInstalled.
 * @returns {Promise<object>}
 */
export async function ensureConfig() {
  return serialize(async () => {
    const stored = await readStored();
    const config = migrateConfig(stored);
    if (!isObject(stored) || stored.version !== config.version) {
      return writeConfig(config);
    }
    return config;
  });
}

// ---------------------------------------------------------------------------
// CRUD de regras
// ---------------------------------------------------------------------------

function pickRuleFields(source) {
  const picked = {};
  if (!isObject(source)) return picked;
  for (const field of RULE_FIELDS) {
    if (field in source) picked[field] = source[field];
  }
  return picked;
}

/**
 * Acrescenta uma regra ao fim da lista (menor prioridade).
 * @param {object} input {pattern, label?, limit, action?, enabled?}
 * @returns {Promise<{ok: boolean, error: string|null, warning?: string|null, rule: object|null}>}
 */
export async function addRule(input) {
  return serialize(async () => {
    const config = migrateConfig(await readStored());
    const check = validateRule(input, config.rules);
    if (!check.valid) return { ok: false, error: check.error, rule: null };

    const rule = {
      id: crypto.randomUUID(),
      ...check.fields,
      createdAt: Date.now()
    };
    config.rules.push(rule);
    await writeConfig(config);
    return { ok: true, error: null, warning: check.warning, rule };
  });
}

/**
 * Altera campos de uma regra existente. 'id' e 'createdAt' são preservados.
 * @param {string} id
 * @param {object} updates subconjunto de {pattern, label, limit, action, enabled}
 * @returns {Promise<{ok: boolean, error: string|null, warning?: string|null, rule: object|null}>}
 */
export async function updateRule(id, updates) {
  return serialize(async () => {
    const config = migrateConfig(await readStored());
    const index = config.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return { ok: false, error: 'Regra não encontrada.', rule: null };

    const current = config.rules[index];
    const merged = { ...current, ...pickRuleFields(updates) };
    const check = validateRule(merged, config.rules, id);
    if (!check.valid) return { ok: false, error: check.error, rule: null };

    const rule = { ...current, ...check.fields };
    config.rules[index] = rule;
    await writeConfig(config);
    return { ok: true, error: null, warning: check.warning, rule };
  });
}

/**
 * Remove uma regra.
 * @param {string} id
 * @returns {Promise<{ok: boolean, error: string|null, removed: object|null}>}
 */
export async function removeRule(id) {
  return serialize(async () => {
    const config = migrateConfig(await readStored());
    const index = config.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return { ok: false, error: 'Regra não encontrada.', removed: null };

    const [removed] = config.rules.splice(index, 1);
    await writeConfig(config);
    return { ok: true, error: null, removed };
  });
}

/**
 * Muda a posição de uma regra na lista — a ordem define a prioridade.
 * @param {string} id
 * @param {number} delta -1 sobe uma posição, +1 desce uma posição
 * @returns {Promise<{ok: boolean, error: string|null, moved: boolean}>}
 */
export async function moveRule(id, delta) {
  return serialize(async () => {
    const config = migrateConfig(await readStored());
    const from = config.rules.findIndex((rule) => rule.id === id);
    if (from === -1) return { ok: false, error: 'Regra não encontrada.', moved: false };

    const step = Math.trunc(Number(delta)) || 0;
    const to = Math.min(config.rules.length - 1, Math.max(0, from + step));
    if (to === from) return { ok: true, error: null, moved: false };

    const [rule] = config.rules.splice(from, 1);
    config.rules.splice(to, 0, rule);
    await writeConfig(config);
    return { ok: true, error: null, moved: true };
  });
}

/**
 * Altera a configuração global.
 * @param {object} partial subconjunto de {defaultAction, notifyOnEnforce, enforceOnStartup}
 * @returns {Promise<{ok: boolean, error: string|null, settings: object|null}>}
 */
export async function updateSettings(partial) {
  return serialize(async () => {
    const config = migrateConfig(await readStored());
    const next = { ...config.settings };

    if (isObject(partial)) {
      if ('defaultAction' in partial) {
        if (!GLOBAL_ACTIONS.includes(partial.defaultAction)) {
          return { ok: false, error: 'Ação padrão inválida.', settings: null };
        }
        next.defaultAction = partial.defaultAction;
      }
      if ('notifyOnEnforce' in partial) next.notifyOnEnforce = Boolean(partial.notifyOnEnforce);
      if ('enforceOnStartup' in partial) next.enforceOnStartup = Boolean(partial.enforceOnStartup);
    }

    config.settings = next;
    await writeConfig(config);
    return { ok: true, error: null, settings: next };
  });
}
