// matcher.js — correspondência de URL por padrão com curinga '*'.
//
// Módulo PURO: não usa nenhuma API do Chrome, para poder ser testado numa
// página local (tests/matcher.test.html) sem npm e sem mocks.
//
// Contrato de correspondência:
//   - Padrão e URL passam pela MESMA normalização antes de comparar.
//   - Esquema e host em minúsculas; o caminho preserva a caixa; o fragmento
//     ('#...') é descartado (armadilha 10 do CLAUDE.md).
//   - Somente '*' é curinga e ele casa com QUALQUER sequência de caracteres,
//     inclusive '/'. Todo o resto é literal (armadilha 9).
//   - Somente http:// e https:// são considerados; URLs internas são ignoradas
//     (regra 9 e armadilha 4).

/** Esquemas que a extensão nunca considera (regra 9 do CLAUDE.md). */
const INTERNAL_SCHEMES = [
  'chrome:',
  'edge:',
  'about:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
  'file:'
];

/** Únicos esquemas aceitos em padrões e em URLs de abas. */
const SUPPORTED_SCHEMES = ['http:', 'https:'];

const WILDCARD = '*';

// O parser de URL não garante como trataria '*' em cada posição (host, porta,
// caminho). Para não depender desse comportamento, o curinga é trocado por um
// marcador puramente alfanumérico e minúsculo — que atravessa a normalização
// intacto — e devolvido ao lugar depois.
const WILDCARD_TOKEN = '0w1ldc4rd0';

const MAX_PATTERN_LENGTH = 2000;

/**
 * Escapa os metacaracteres de regex, exceto '*' (armadilha 9).
 * @param {string} text
 * @returns {string}
 */
export function escapeRegex(text) {
  return text.replace(/[.+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * A URL usa um dos esquemas internos que a extensão ignora?
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isInternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim().toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * A URL é candidata a ser contada/limitada? (http ou https e não interna)
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isSupportedUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim().toLowerCase();
  if (url === '' || isInternalUrl(url)) return false;
  return SUPPORTED_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * Normaliza uma URL absoluta para a forma usada na comparação.
 * Descarta fragmento, credenciais e porta padrão; minúsculas em esquema e host.
 * @param {unknown} rawUrl
 * @returns {string|null} URL normalizada ou null se inutilizável.
 */
export function normalizeUrl(rawUrl) {
  if (!isSupportedUrl(rawUrl)) return null;
  return normalizeAbsolute(rawUrl.trim());
}

/**
 * Coloca os escapes percentuais em MAIÚSCULAS. O RFC 3986 (secão 6.2.2.1) diz
 * que %2f e %2F representam o mesmo octeto, mas o parser de URL preserva a
 * caixa que veio escrita. Sem uniformizar, um padrão com %2F deixaria de casar
 * uma URL escrita com %2f — as duas pontas normalizam igual justamente para
 * que diferenças assim não existam.
 */
function normalizePercentEscapes(text) {
  return text.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
}

function normalizeAbsolute(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (!SUPPORTED_SCHEMES.includes(parsed.protocol)) return null;
  // 'host' já inclui a porta quando ela não é a padrão e exclui credenciais.
  const path = normalizePercentEscapes(parsed.pathname);
  const query = normalizePercentEscapes(parsed.search);
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}

/**
 * O padrão digitado traz um caminho explícito depois do host? Serve para
 * distinguir 'https://exemplo.com*' (curinga no host) de 'https://exemplo.com/*'
 * (curinga no caminho), que o parser de URL torna indistinguíveis depois de
 * acrescentar a barra que falta.
 */
function hasExplicitPath(input) {
  const schemeEnd = input.indexOf(':');
  // Remove o esquema e as barras do '//' para sobrar apenas autoridade + resto.
  const authority = input.slice(schemeEnd + 1).replace(/^\/+/, '');
  return /[/?#]/.test(authority);
}

/** Trecho do padrão normalizado a partir do caminho (tudo depois do host). */
function pathPortion(normalized) {
  const hostStart = normalized.indexOf('//') + 2;
  const pathStart = normalized.indexOf('/', hostStart);
  // normalizeAbsolute sempre devolve ao menos '/' como caminho.
  return pathStart === -1 ? '/' : normalized.slice(pathStart);
}

/**
 * Valida um padrão digitado pelo usuário (regra 13 do CLAUDE.md).
 * @param {unknown} rawPattern
 * @returns {{valid: boolean, error: string|null, warning: string|null, normalized: string|null}}
 */
export function validatePattern(rawPattern) {
  const fail = (error) => ({ valid: false, error, warning: null, normalized: null });

  if (typeof rawPattern !== 'string' || rawPattern.trim() === '') {
    return fail('Informe um padrão de URL.');
  }

  const input = rawPattern.trim().replace(/\*+/g, WILDCARD);

  if (input.length > MAX_PATTERN_LENGTH) {
    return fail(`Padrão muito longo (máximo ${MAX_PATTERN_LENGTH} caracteres).`);
  }
  if (input.toLowerCase().includes(WILDCARD_TOKEN)) {
    // Case-insensitive de propósito: o host é normalizado para minúsculas
    // mais abaixo (armadilha 10), então um host digitado em MAIÚSCULAS que
    // colida com o token só apareceria aqui depois de já ter sido rebaixado —
    // checar em minúsculas agora fecha essa brecha antes que ela aconteça.
    return fail('O padrão contém uma sequência reservada pela extensão. Remova-a.');
  }
  if (input.startsWith(WILDCARD)) {
    return fail('O esquema não aceita curinga: comece com http:// ou https://.');
  }
  if (isInternalUrl(input)) {
    return fail('Endereços internos do navegador não podem ser limitados.');
  }
  if (!isSupportedUrl(input)) {
    return fail('Use uma URL completa começando com http:// ou https:// (ex.: https://exemplo.com/pasta/*).');
  }

  // Curinga no fim de um padrão SEM caminho é ambíguo e, pior, silenciosamente
  // inútil: o parser acrescenta o caminho '/' depois do curinga, então
  // 'https://portal.exemplo.com*' virava 'https://portal.exemplo.com*/' e
  // passava a casar somente endereços terminados em barra. Em vez de adivinhar
  // qual das duas leituras o usuário quis, pedimos a barra explícita.
  if (!hasExplicitPath(input) && input.endsWith(WILDCARD)) {
    return fail(
      'Falta a barra antes do curinga. Escreva https://exemplo.com/* para limitar todo o site.'
    );
  }

  const normalizedWithToken = normalizeAbsolute(input.split(WILDCARD).join(WILDCARD_TOKEN));
  if (normalizedWithToken === null) {
    return fail('Padrão inválido. Exemplo válido: https://exemplo.com/pasta/*');
  }

  const normalized = normalizedWithToken.split(WILDCARD_TOKEN).join(WILDCARD);

  // O aviso olha o CAMINHO, não o padrão inteiro: um curinga só no host
  // (https://*.exemplo.com/login) ainda casa um único caminho, e antes essa
  // situação passava calada porque havia '*' em algum lugar.
  let warning = null;
  if (!pathPortion(normalized).includes(WILDCARD)) {
    warning = normalized.includes(WILDCARD)
      ? 'O curinga está só no host: este padrão casa apenas este caminho exato. Use * no fim para incluir as subpáginas.'
      : 'Sem curinga: o padrão casa somente com esta URL exata. Use * no fim para incluir as subpáginas.';
  }

  return { valid: true, error: null, warning, normalized };
}

/**
 * Normaliza um padrão, preservando os curingas.
 * @param {unknown} rawPattern
 * @returns {string|null}
 */
export function normalizePattern(rawPattern) {
  return validatePattern(rawPattern).normalized;
}

/**
 * Compila um padrão em RegExp ancorada. Chamadores que repetem a comparação
 * muitas vezes devem guardar o resultado em vez de recompilar.
 * @param {unknown} rawPattern
 * @returns {RegExp|null}
 */
export function patternToRegex(rawPattern) {
  const normalized = normalizePattern(rawPattern);
  if (normalized === null) return null;
  const body = normalized.split(WILDCARD).map(escapeRegex).join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * A URL casa com o padrão?
 * @param {unknown} rawUrl
 * @param {unknown} rawPattern
 * @returns {boolean}
 */
export function matchUrl(rawUrl, rawPattern) {
  const url = normalizeUrl(rawUrl);
  if (url === null) return false;
  const regex = patternToRegex(rawPattern);
  if (regex === null) return false;
  return regex.test(url);
}

/**
 * Primeira regra habilitada que casa com a URL — a ordem da lista é a
 * prioridade: a primeira que casar vence.
 * @param {unknown} rawUrl
 * @param {Array<object>} rules
 * @returns {object|null}
 */
export function findFirstMatchingRule(rawUrl, rules) {
  const url = normalizeUrl(rawUrl);
  if (url === null || !Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const regex = patternToRegex(rule.pattern);
    if (regex !== null && regex.test(url)) return rule;
  }
  return null;
}

/**
 * Sugestões de padrão para uma URL, da mais específica para a mais ampla.
 * Usado pela interface para pré-preencher o campo de padrão.
 * @param {unknown} rawUrl
 * @returns {Array<{pattern: string, label: string}>}
 */
export function suggestPatterns(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (normalized === null) return [];

  const parsed = new URL(normalized);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const directory = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);

  // Neste padrão o '*' é SEMPRE curinga e não existe forma de escapá-lo. Se a
  // URL da aba tiver um '*' literal, embutir esse trecho numa sugestão o
  // transformaria em curinga e a regra ficaria mais ampla do que o rótulo
  // promete — então só sugerimos os trechos que não contêm '*'.
  const literal = (text) => !text.includes(WILDCARD);

  const candidates = [];
  if (literal(origin) && literal(directory)) {
    candidates.push({ pattern: `${origin}${directory}${WILDCARD}`, label: 'Esta pasta e subpáginas' });
  }
  if (literal(origin)) {
    candidates.push({ pattern: `${origin}/${WILDCARD}`, label: 'Todo o site' });
  }
  // A query entra aqui porque normalizeUrl() a preserva (só o fragmento é
  // descartado) — sem ela, esta sugestão não casaria com a própria URL que
  // a gerou quando a URL tiver "?...".
  if (literal(origin) && literal(parsed.pathname) && literal(parsed.search)) {
    candidates.push({
      pattern: `${origin}${parsed.pathname}${parsed.search}`,
      label: 'Somente esta URL'
    });
  }

  const seen = new Set();
  return candidates.filter(({ pattern }) => {
    if (seen.has(pattern)) return false;
    seen.add(pattern);
    return true;
  });
}
