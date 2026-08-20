# CLAUDE.md — Limitador de Abas por URL (Extensão Chrome)

## 1. Objetivo do projeto

Criar uma extensão para o Google Chrome (Manifest V3) que **limite o número máximo de abas
abertas por site**, com limites definidos individualmente por padrão de URL.

Exemplo canônico: cadastrar `https://portal.exemplo.com/mfa/*` com limite **3** →
o navegador nunca terá mais de 3 abas desse endereço abertas ao mesmo tempo.

Requisito não funcional de primeira classe: **a extensão não pode ficar consumindo recursos
do navegador.** Ela é 100% orientada a eventos e fica dormente quando nada acontece.

## 2. Contexto e decisões já tomadas

Projeto iniciado do zero em 19/08/2026.
Decisões confirmadas pelo dono do projeto — **não revisitar sem autorização**:

| Tema | Decisão |
|---|---|
| Correspondência de URL | **Padrão com curinga `*` definido por item** (ex.: `https://host/mfa/*`) |
| Ação ao exceder o limite | **As 4 opções coexistem e são alternáveis pela interface**: `close` (fechar a aba nova e focar uma existente), `closeQuiet` (fechar a aba nova sem trocar de aba nem de janela), `block` (manter a aba com página de aviso), `notify` (só avisar). `closeQuiet` foi acrescentada em 20/08/2026 a pedido do dono, depois do teste no navegador |
| Escopo da contagem | **Todas as janelas normais do perfil**; janelas anônimas ficam de fora |
| Persistência | `chrome.storage.local` — regras sobrevivem a fechar/abrir o navegador |
| Ferramental | **JS/HTML/CSS puros, sem build, sem npm, sem framework** — somente ferramentas gratuitas |
| Ação padrão | Global (radio com as 4 opções) + override opcional por regra (`default \| close \| closeQuiet \| block \| notify`) |
| Aba sacrificada | Sempre a que **causou** o excesso (recém-aberta ou que acabou de navegar) — nunca uma aba antiga |
| Restauração de sessão | Na inicialização do Chrome, **não fechar** abas restauradas: apenas recontar (ajuste `enforceOnStartup`, desligado por padrão) |

## 3. Estrutura do projeto

```
extensao/
├─ CLAUDE.md
├─ README.md                  # Etapa 7
├─ manifest.json              # MV3
├─ src/
│  ├─ background.js           # service worker: listeners + motor de enforcement
│  ├─ lib/
│  │  ├─ matcher.js           # padrão -> RegExp, validação, normalização, sugestões
│  │  ├─ storage.js           # schema, defaults, CRUD de regras, migração
│  │  └─ counter.js           # contagem de abas por regra + badge
│  ├─ popup/
│  │  ├─ popup.html
│  │  ├─ popup.css
│  │  └─ popup.js
│  └─ blocked/
│     ├─ blocked.html
│     ├─ blocked.css
│     └─ blocked.js
├─ icons/                     # icon16.png, icon32.png, icon48.png, icon128.png
└─ tests/
   └─ matcher.test.html       # runner de asserções em página local (sem npm)
```

### Schema de dados (`chrome.storage.local`, chave `config`)

```json
{
  "version": 1,
  "settings": {
    "defaultAction": "close",
    "notifyOnEnforce": true,
    "enforceOnStartup": false
  },
  "rules": [
    {
      "id": "uuid",
      "pattern": "https://portal.exemplo.com/mfa/*",
      "label": "Portal MFA",
      "limit": 3,
      "action": "default",
      "enabled": true,
      "createdAt": 0
    }
  ]
}
```

Regras são avaliadas na ordem da lista: **a primeira que casar vence** (mostrar isso na UI).

## 4. Etapas do projeto (executar uma por vez)

| # | Etapa | Entrega | Verificação |
|---|---|---|---|
| 0 | Este `CLAUDE.md` | Contrato do projeto | Arquivo lido e aprovado |
| 1 | Fundação | `manifest.json`, árvore de pastas, popup mínimo, ícones | Carrega em `chrome://extensions` sem erros; popup abre |
| 2 | Dados e matcher | `matcher.js`, `storage.js`, `tests/matcher.test.html` | Todas as asserções verdes; regra sobrevive a reiniciar o Chrome |
| 3 | Motor de enforcement | `background.js`, `counter.js` | Limite 3 → a 4ª aba é impedida; badge `3/3` |
| 4 | Popup (CRUD + ações) | `popup.*` | Adicionar/remover/editar limite; 2 padrões com limites independentes; radio das 4 ações funciona |
| 5 | Bloqueio e avisos | `blocked.*`, notificações | Modo `block` mostra a página; modo `notify` não fecha nada |
| 6 | Endurecimento | Casos-limite e desempenho | Restauração de sessão, 10 Ctrl+clique, anônimo, "service worker (inativo)" |
| 7 | Aceitação e entrega | `README.md`, `.zip`, revisão final | Matriz de testes 100%; instalação limpa a partir do `.zip` |

### Modelo e esforço sugeridos por etapa

| Etapa | Modelo | Esforço |
|---|---|---|
| 1 | Haiku 4.5 | — (sem controle de esforço) |
| 2 | Opus 5 | `high` |
| 3 | Opus 5 | `xhigh` |
| 4 | Sonnet 5 | `medium` |
| 5 | Sonnet 5 | `low` |
| 6 | Opus 5 | `xhigh` |
| 7 | Sonnet 5 | `low` (+ `/code-review high` no Opus 5) |

Subir modelo/esforço quando: 2 tentativas de correção falharem no mesmo bug; API do Chrome se
comportar de forma inesperada; mexer em `matcher.js` ou na fila de serialização; mudança em 3+
arquivos; revisão final. Fable 5 só como último recurso (≈2× o custo do Opus 5).
Rodar `/clear` entre etapas — cada etapa é autocontida.

## 5. Tecnologias

- **Chrome Extension Manifest V3** — service worker (`type: "module"`), `chrome.action` com popup.
- **JavaScript ES2022 puro** (módulos ES nativos), **HTML5**, **CSS3**. Sem TypeScript, sem bundler.
- **APIs Chrome usadas:** `chrome.tabs` (`query`, `remove`, `update`, `onCreated`, `onUpdated`,
  `onRemoved`, `onActivated`), `chrome.windows.update`, `chrome.storage.local` +
  `storage.onChanged`, `chrome.action.setBadgeText/setBadgeBackgroundColor`,
  `chrome.notifications`, `chrome.runtime` (`onInstalled`, `onStartup`, `getURL`).
- **Permissões declaradas:** `["tabs", "storage", "notifications"]` — nada além disso.
- **Testes:** página HTML local com asserções próprias (sem npm, sem Jest/Vitest).
- **Ícones:** gerados localmente por script PowerShell com `System.Drawing` (nativo do Windows).
- Custo total do ferramental: **R$ 0,00** — nenhuma dependência paga ou serviço externo.

## 6. Regras de trabalho

1. **Uma etapa por vez. Nunca avançar para a etapa seguinte sem o dono do projeto pedir
   explicitamente.** Ver a seção 9.
2. Só criar/alterar arquivos que pertençam à etapa em execução.
3. Ao terminar uma etapa: listar arquivos criados/alterados, dizer como verificar e **parar**.
4. Nada de refatorar código de etapas anteriores "de passagem" — se algo estiver errado, reportar
   e esperar decisão.
5. Todos os listeners de eventos são registrados **no nível superior** de `background.js`
   (exigência do MV3 — listener registrado dentro de um `await` não sobrevive ao worker dormir).
6. Nenhum estado em memória é fonte da verdade: depois de despertar, sempre reler as regras do
   storage e recontar as abas com `chrome.tabs.query`.
7. Toda verificação de limite passa por uma **fila serializada** (uma verificação por vez) para
   evitar corrida quando várias abas abrem juntas.
8. Nunca fechar uma aba que o usuário já estava usando: a aba impedida é sempre a que causou o
   excesso. Se ela for a única da janela, navegar para `blocked.html` em vez de fechar (para não
   fechar a janela).
9. Ignorar URLs internas: `chrome://`, `edge://`, `about:`, `chrome-extension://`, `devtools://`,
   `view-source:`, `file://`.
10. Ignorar abas de janelas anônimas (`tab.incognito === true`) e janelas não normais
    (popups, app windows) — `chrome.tabs.query({ windowType: "normal" })`.
11. Código e comentários em **português**; nomes de identificadores em inglês (`limit`, `rules`,
    `matchTab`) para ficar idiomático com as APIs do Chrome.
12. Sem `console.log` ruidoso na versão final: logs só atrás de um sinalizador `DEBUG`.
13. Validar toda entrada do usuário: padrão não vazio e válido, limite inteiro entre 1 e 99,
    padrão duplicado rejeitado com mensagem clara.
14. Alterações no schema do storage exigem incrementar `version` e escrever a migração.

## 7. Restrições (o que NÃO fazer)

- **Não usar polling:** proibido `setInterval`, `setTimeout` recorrente, `chrome.alarms` ou
  qualquer laço de verificação periódica. A extensão só reage a eventos.
- **Não usar content scripts** nem `host_permissions` — não é necessário injetar nada nas páginas.
- **Não fazer nenhuma requisição de rede.** Sem CDN, sem telemetria, sem analytics, sem fontes
  externas. Tudo local.
- **Não adicionar dependências:** sem npm, sem `package.json`, sem bundler, sem framework, sem
  biblioteca de UI. Nada de ferramenta paga.
- **Não usar `webRequest`/`declarativeNetRequest`** — o escopo é aba, não requisição.
- **Não fechar abas em massa** e não fechar abas restauradas na inicialização (a não ser que
  `enforceOnStartup` esteja ligado pelo usuário).
- **Não usar `storage.sync`** nesta versão (exigiria login no Chrome); `storage.local` é a decisão.
- **Não coletar nem enviar dados de navegação** para lugar algum.
- **Não publicar na Chrome Web Store** nem criar conta em nenhum serviço: a instalação é local
  ("Carregar sem compactação").
- **Não alterar arquivos fora da pasta do projeto.**
- Não introduzir suporte a Firefox/Safari agora (Edge e Brave funcionam por serem Chromium, mas
  não são alvo de teste).

## 8. Padrões de trabalho

- **Fluxo de cada etapa:** (1) reler este arquivo; (2) implementar somente o escopo da etapa;
  (3) recarregar a extensão em `chrome://extensions` e conferir o botão "Erros";
  (4) executar a verificação da etapa; (5) reportar em texto curto o que foi feito, como testar
  e o que ficou pendente; (6) **parar e esperar autorização**.
- **Verificação sempre no navegador real**, não só por leitura de código: `chrome://extensions`
  → DevTools do service worker (console limpo), Gerenciador de Tarefas do Chrome (Shift+Esc)
  para consumo, `tests/matcher.test.html` para a lógica pura.
- **Estilo de código:** módulos ES, `const`/`let`, `async/await`, funções pequenas com uma
  responsabilidade, sem herança de classes desnecessária, indentação de 2 espaços, aspas simples.
- **Nomes de arquivo** em minúsculas com hífen quando composto.
- **Sem git nesta fase** (o diretório não é um repositório). Se o dono pedir versionamento,
  criar `.gitignore` antes do primeiro commit.
- **Ao encontrar ambiguidade:** implementar a parte que não depende da resposta, declarar a
  premissa adotada e perguntar no fim — não travar a etapa inteira.
- **Relatórios honestos:** se um teste falhou ou uma parte foi pulada, dizer explicitamente.

## 9. Regra de ouro: uma etapa por vez

> **O modelo NÃO deve avançar para a próxima etapa sem que o dono do projeto autorize ou peça.**

- Terminar a etapa → reportar → **parar**. Sem "já aproveitei e adiantei a Etapa 4".
- "Continue" sem indicar etapa = continuar a etapa **atual**, não iniciar a seguinte.
- Se o escopo de uma etapa parecer pequeno demais, **não** juntar com a próxima: reportar e
  esperar.
- Se durante uma etapa aparecer algo que pertence a outra, anotar como pendência e seguir.

## 10. Critérios de conclusão do projeto

O projeto está concluído quando **todos** os itens abaixo forem verdadeiros:

**Funcionais**
1. É possível adicionar um padrão de URL com curinga e um limite de abas pela interface.
2. É possível remover um padrão e editar o limite de um padrão existente.
3. Padrões diferentes têm limites independentes (ex.: site A = 3, site B = 1) e ambos são
   respeitados simultaneamente.
4. Com limite 3 em `https://portal.exemplo.com/mfa/*`, a 4ª tentativa de abrir a
   página é impedida conforme a ação escolhida.
5. As 4 ações (`close`, `closeQuiet`, `block`, `notify`) funcionam e podem ser alternadas na
   interface, com efeito imediato e sem recarregar a extensão.
6. A contagem soma abas de **todas as janelas normais** do perfil; abas anônimas não contam.
7. As regras continuam registradas depois de fechar e reabrir o Chrome, e depois de reiniciar o
   Windows.
8. O badge do ícone mostra a contagem `n/limite` quando a aba ativa casa com uma regra.

**Não funcionais**
9. Em repouso, `chrome://extensions` mostra o service worker como **inativo** e o Gerenciador de
   Tarefas do Chrome não mostra consumo contínuo de CPU pela extensão.
10. Nenhum `setInterval`/`setTimeout` recorrente/`chrome.alarms` no código; zero requisições de
    rede; zero content scripts; permissões limitadas a `tabs`, `storage`, `notifications`.
11. Abrir 10 abas rapidamente (Ctrl+clique) nunca ultrapassa o limite (fila serializada
    funcionando).
12. Reiniciar o Chrome com abas restauradas acima do limite não fecha nada automaticamente.
13. Nenhuma exceção no console do service worker nem no do popup durante a matriz de testes.
14. `tests/matcher.test.html` com 100% das asserções verdes.

**Entrega**
15. `README.md` explica instalação ("Carregar sem compactação"), uso, sintaxe dos padrões e
    limitações conhecidas.
16. `.zip` do projeto gerado e testado por instalação num perfil limpo do Chrome.

## 11. Armadilhas conhecidas (consultar antes de codar)

1. Aba recém-criada tem `url: ""` — a URL real está em `tab.pendingUrl`. Verificar `onCreated`
   com `pendingUrl` permite impedir **antes** de a página carregar (evita criar sessão no portal);
   confirmar depois em `onUpdated`.
2. `chrome.tabs.onUpdated` aceita filtro (`{ properties: ["url", "status"] }`) — confirmar a
   assinatura na documentação; se for rejeitado, usar listener sem filtro com
   `if (!changeInfo.url) return;` na primeira linha.
3. Ler `tab.url` de qualquer aba exige a permissão `tabs` (por isso o Chrome avisa sobre
   "histórico de navegação" na instalação — é esperado e inevitável).
4. `blocked.html` tem URL `chrome-extension://…`, que nunca casa com padrões `http(s)` do
   usuário → não há risco de loop. Mesmo assim, ignorar URLs internas na entrada.
5. Fechar a última aba de uma janela fecha a janela: nesse caso, navegar para `blocked.html`.
6. O service worker morre após ~30 s de inatividade: nada de estado global persistente em
   memória; o cache de regras é apenas otimização, invalidado por `storage.onChanged`.
7. `chrome.notifications.create` precisa de um `iconUrl` válido — depende dos ícones da Etapa 1.
8. Focar uma aba existente exige **duas** chamadas: `chrome.tabs.update(id, {active:true})` **e**
   `chrome.windows.update(windowId, {focused:true})`.
9. Escape de regex no matcher: escapar `. + ? ^ $ { } ( ) | [ ] \ /` e converter **somente** `*`
   em `.*`, com âncoras `^…$`.
10. Comparar esquema e host em minúsculas; caminho preserva caixa; ignorar o fragmento (`#…`).
