# MANUAL — Como usar a IA Investidora (guia do dono)

> Guia prático, em linguagem do dia a dia, para operar o sistema no dia a dia.
> Aqui é o "como fazer". A explicação técnica de como o sistema funciona por
> dentro está no `CLAUDE.md`; as regras de negócio, no `regras.md`.

Índice:
1. [O que o sistema faz](#1-o-que-o-sistema-faz)
2. [Ligar e desligar o bot](#2-ligar-e-desligar-o-bot)
3. [A dashboard — as telas](#3-a-dashboard--as-telas)
4. [Cadastrar um ativo](#4-cadastrar-um-ativo)
5. [Configurações de um ativo (campo a campo)](#5-configurações-de-um-ativo-campo-a-campo)
6. [Simulação × Real (como virar com segurança)](#6-simulação--real-como-virar-com-segurança)
7. [Custos: depósito × comissão (não confundir!)](#7-custos-depósito--comissão-não-confundir)
8. [Toro — modo assistido (ações e FIIs da B3)](#8-toro--modo-assistido-ações-e-fiis-da-b3)
9. [Excluir ativo](#9-excluir-ativo)
10. [Quando dá erro (troubleshooting)](#10-quando-dá-erro-troubleshooting)
11. [Segurança](#11-segurança)

---

## 1. O que o sistema faz

Um robô que analisa ativos sozinho, 24/7, e decide **COMPRAR / VENDER /
AGUARDAR** com ajuda de uma IA (Gemini). Hoje opera em quatro plataformas:

- **Mercado Bitcoin (MB)** — cripto (BTC, ETH, SOL), em reais, mercado 24h.
- **Tastytrade (TT)** — **ações dos EUA**, em **dólares (USD)**; só roda no
  horário do pregão de Nova York (o robô descobre sozinho o horário e os
  feriados, direto na corretora — fora do pregão ele nem gasta análise).
- **Binance (BN)** — cripto em reais (pares `BTCBRL` etc.), taxas bem menores
  que as do MB (0,10% spot).
- **Toro (TORO)** — **ações e FIIs da B3**, em **modo ASSISTIDO** (seção 8): a
  Toro não tem API, então o robô analisa e **recomenda** — quem executa é
  você, e depois registra a operação na dashboard.

Hospedado na nuvem (Render), sempre ligado.

Regras que o robô **nunca** quebra, aconteça o que acontecer:
- Nunca vende no prejuízo (calcula lucro líquido já com as taxas por posição).
- A IA nunca calcula nem acessa a internet — ela só interpreta números prontos.
- Em Modo Simulação, nenhuma ordem real é enviada.

> A integração com a Interactive Brokers (V3) foi **revertida em 2026-07-16**
> (conta bloqueada na corretora) e substituída pela Tastytrade. O código da
> IBKR está preservado no histórico git; ver `ROADMAP.md`.

---

## 2. Ligar e desligar o bot

Não precisa fazer nada: o bot roda sozinho 24/7 no Render (nuvem). É o modo
normal. Para rodar localmente (testes), use `npm start` na pasta do projeto
(`Ctrl+C` para parar) — nesse caso, **suspenda antes o bot do Render** (painel
do Render → seu serviço → *Suspend*; depois, *Resume*), porque dois bots no
mesmo banco disputam a mesma fila.

---

## 3. A dashboard — as telas

Endereço: **<seu-projeto>.web.app** (login restrito à sua conta).

- **Visão geral** — patrimônio consolidado, o tile **"Se vender tudo agora"**
  (seção 6.2), o comparativo **Rendimento real × 106% do CDI** (seção 6.1) e a
  tabela de ativos.
- **Regras gerais da IA** — regras curtas que valem para TODOS os ativos
  (primeira camada do "pensamento" da IA).
- **Supervisão semanal** — o que a IA supervisora escreveu no prompt do
  analista, o diagnóstico da semana e o botão para desligar tudo (seção 8.7).
- **Tela de cada ativo** — números, última decisão da IA, posições abertas,
  gráficos, histórico, a **configuração do ativo** e os editores de **prompt**
  e **contexto** daquele ativo. No fim, a **Zona de risco** (excluir). O
  gráfico **Preço e operações** mostra a oscilação do preço com as operações
  executadas por cima: ▲ amarelo = compra, ▼ azul = venda — dá para conferir
  visualmente se o bot comprou na baixa e vendeu na alta (só operações do
  modo atual: simulação e real não se misturam).
- **Tela da plataforma** — **status** (autenticação na corretora, testada de
  hora em hora pelo bot, e situação do pregão), chaves/credenciais, cadeia de
  modelos da IA, **cadastro de novo ativo** e o **template** (prompt padrão de
  todos os ativos dela).

> **Template, prompt e contexto são TEXTO para a IA** — não são lugar de taxa
> nem de número. Taxas ficam na *configuração do ativo* (seção 5).

---

## 4. Cadastrar um ativo

BTC/ETH/SOL já vêm cadastrados no Mercado Bitcoin. Para cadastrar um ativo
novo (em qualquer plataforma): **tela da plataforma → Cadastrar novo ativo**,
informe o código e um nome:

- **Mercado Bitcoin**: código da cripto (ex.: `XRP`) — o par vira `XRP-BRL`.
- **Tastytrade**: **ticker** da ação nos EUA (ex.: `AAPL`, `MSFT`, `KO`).
- **Binance**: código da cripto (ex.: `BTC`) — o par vira `BTCBRL` (sem hífen;
  é a grafia da Binance). Confira em binance.com se o par em BRL existe.
- **Toro (modo assistido)**: **ticker** da B3 (ex.: `PETR4`, `VALE3`,
  `BOVA11`). O ativo nasce configurado para análise em candles **diários**
  (swing trade) e com dividendos automáticos ligados — ver a seção 8.

Todo ativo nasce **desligado, em simulação e com orçamento 0** — configure e
só então ligue (seções 5 e 6).

### 4.1 Primeira configuração da Tastytrade (uma vez só)

O bot cria a plataforma "Tastytrade" sozinho, mas ela precisa das suas chaves:

1. Entre em **my.tastytrade.com** → *Manage* → *API Access* →
   **OAuth Applications** → crie uma aplicação (marque todos os escopos:
   `read`, `trade`) e guarde o **Client ID** e o **Client Secret**.
2. Na aplicação criada → **Create Grant** (*New Personal OAuth Grant*) →
   copie o **Refresh Token** (não expira; se gerar outro, o antigo continua
   valendo até ser revogado).
3. Na dashboard → **Plataforma Tastytrade** → cole Client ID, Client Secret e
   Refresh Token (o número da conta é opcional — vazio usa a primeira). Cole
   também a **API Key da IA** (a mesma do Gemini que você já usa no MB).
4. Aguarde a próxima rodada do bot: o **status** da tela deve mostrar
   "✅ autenticada". Se mostrar ❌, confira as chaves (o erro aparece junto).

**Taxas na Tastytrade**: comissão de ações é **zero** — sobram só centavos de
taxas regulatórias na venda. O ativo já nasce com 0% compra / 0,02% venda, e a
taxa REAL de cada ordem é capturada automaticamente da API (dry-run) — você
não precisa preencher nada.

**Moeda**: tudo na Tastytrade é em **dólar (USD)** — os números da tela do
ativo e o caixa são em US$. Na **visão geral** o patrimônio e o comparativo
"Rendimento × 106% do CDI" são consolidados em **reais**: o lucro em dólar é
convertido pela cotação do Banco Central (a mesma do patrimônio) e somado ao
total em R$. O detalhe do lucro por moeda continua aparecendo separado
(no formato "R$ … · US$ …") no cabeçalho do card; se em algum momento faltar
a cotação do dia, aquela moeda fica de fora do total até o câmbio voltar.

### 4.2 Primeira configuração da Binance (uma vez só)

O bot cria a plataforma "Binance" sozinho, mas ela precisa das suas chaves:

1. Entre em **binance.com** → perfil → **Gerenciamento de API**
   (*API Management*) → **Criar API** (tipo *System generated*).
2. Nas restrições da chave, habilite **apenas** *Enable Reading* e
   *Enable Spot & Margin Trading*. **Nunca** habilite saque (*Enable
   Withdrawals*) — o bot não precisa e é mais seguro sem.
3. Copie a **API Key** e o **Secret** (o Secret só aparece na criação — se
   perder, gere outra chave).
4. Na dashboard → **Plataforma Binance** → cole API Key e Secret. Cole também
   a **API Key da IA** (a mesma do Gemini que você já usa no MB).
5. Aguarde a próxima rodada do bot: o **status** da tela deve mostrar
   "✅ autenticada". Se mostrar ❌, confira as chaves (o erro aparece junto).

**Taxas na Binance**: a taxa spot padrão é **0,10%** por operação (bem menor
que a do MB) — o ativo já nasce com 0,10% compra / 0,10% venda. A taxa REAL
de cada ordem vem da própria API (fills) e é registrada na operação. Confira
a taxa da SUA conta em binance.com → *Taxas de negociação* e ajuste a config
se for diferente.

**Importante — desconto BNB**: na conta da Binance, **desligue** a opção
"Usar BNB para pagar taxas" (*Fee* → *Using BNB to pay for fees*). Com ela
ligada a comissão é cobrada em BNB e o registro do custo fica menos preciso;
com ela desligada a comissão vem em BRL (venda) ou no próprio ativo (compra),
que o bot converte com exatidão.

**Moeda**: os pares usados são em **reais** (`BTCBRL` etc.) — caixa e números
da tela em R$, como no Mercado Bitcoin. Deixe saldo em BRL na carteira SPOT
da Binance para o robô poder comprar.

---

## 5. Configurações de um ativo (campo a campo)

> **Edições valem em até 5 minutos.** Desde a V5.2, o robô guarda uma cópia
> das configurações (ativos, chaves, prompts, contexto) por 5 minutos para não
> estourar o limite gratuito de leituras do Firestore. Salvou algo na dashboard
> e o robô ainda não obedeceu? Espere até 5 min — não precisa reiniciar nada.
> As telas da dashboard continuam atualizando na hora, como sempre.

Na tela do ativo, seção **Configurações do ativo**:

| Campo | O que é |
|---|---|
| **Ativo LIGADO** | Liga/desliga o robô para este ativo. Desligado = ignorado. |
| **Modo Simulação** | Marcado = ordens fictícias. Desmarcado = **ordens REAIS** (seção 6). |
| **Tempo entre análises (min)** | De quanto em quanto tempo o ativo é analisado. |
| **Variação mínima p/ chamar a IA (%)** | Se o preço mexeu menos que isso desde a última análise, o robô nem chama a IA (economiza cota). |
| **Divergência máx. na execução (%)** | Se o preço mudou muito entre a análise e a hora de executar, cancela por segurança. |
| **Tempo de reset (dias)** | Sem operar há tantos dias, sinaliza "reset" no cenário da IA. |
| **Taxa de compra (%)** | Comissão de compra que a corretora cobra de você (MB: ~0,7% real; Binance: 0,10%; Tastytrade: 0). |
| **Taxa de venda (%)** | Comissão de venda (Binance: 0,10%; Tastytrade: deixe os 0,02% de reserva regulatória). |
| **Limite de perda diária (%)** | Se o patrimônio da plataforma cair tanto no dia, bloqueia novas compras até o dia virar. 0 desliga. |
| **Orçamento do ativo (%)** | Teto de quanto do patrimônio da plataforma este ativo pode ocupar. **0 = não compra** (é assim que ativo novo nasce). Abaixo do campo, a dashboard mostra a **soma dos orçamentos de todos os ativos** da plataforma — se passar de 100%, fica **vermelho** (você ainda consegue salvar; é só um aviso para reequilibrar entre os ativos). |
| **Distância máxima do stop-loss (%)** | Teto de quão LONGE do preço de compra a IA pode colocar o chão da posição (padrão 15%). Se ela pedir um chão mais distante, o robô **aperta** o valor até esse limite. É a trava que impede um stop tão largo que na prática não protege nada (seção 6.5). |
| **Folga do stop-loss (%)** | O contrário do campo acima, e o mais importante dos dois: distância **MÍNIMA** entre o preço e o chão (padrão 2%). Chão que a IA peça mais perto que isso é recusado ou alargado, e é também a distância em que o robô sobe o chão sozinho. Foi o que resolveu o stop vendendo em prejuízo — leia a **seção 6.5.1** antes de mexer. |
| **Trava de lucro — gatilho (%)** | Quanto a posição precisa subir acima do ponto de empate para o robô armar a trava que **realiza** o lucro (padrão 1%). **0 desliga a trava** neste ativo. Seção 6.5.2. |
| **Trava de lucro — devolução (%)** | Quanto do **topo** da posição o robô aceita devolver antes de vender e embolsar (padrão 0,8%). Menor = realiza mais cedo e mais vezes. Seção 6.5.2. |
| **Ordem mínima (valor/quantidade)** | Pisos operacionais. |

### Sobre as taxas (importante)
- Coloque a **taxa real** que o Mercado Bitcoin cobra de você (percentual por
  operação).
- **NUNCA** coloque aqui o custo de **depositar** dinheiro (seção 7).

---

## 6. Simulação × Real (como virar com segurança)

- Todo ativo nasce em **Modo Simulação**: o robô faz tudo igual (analisa,
  decide, registra, mostra na dashboard), mas **não envia ordem de verdade**.
  É onde você valida se está feliz com o comportamento.
- Para operar **de verdade**, você desmarca "Modo Simulação" na config do
  ativo e salva. **Só então** ordens reais acontecem.
- Simulação e real têm estatísticas separadas — um nunca contamina o outro.
- Cada ativo é independente: dá para rodar BTC real com ETH/SOL em simulação.

**Checklist antes de virar um ativo para real:**
1. Rodou em simulação e você gostou do comportamento.
2. Conferiu o **orçamento** (quanto ele pode usar) e as taxas.
3. Só então: desmarca Simulação → salva.

### 6.1 Comparativo: rendimento real × 106% do CDI

Na **Visão geral** há um card que responde "estou ganhando mais que a renda
fixa?". Como ele funciona:

- Só conta o **lucro realizado de ativos em modo REAL** — simulação nunca
  entra. O total também fica gravado no banco (doc `global/renda_real`,
  campos `lucro_real_total` e `lucro_real_por_moeda`).
- A régua começa **no momento em que o primeiro ativo entra em modo real** e
  não volta atrás (nem se tudo voltar para simulação).
- A **Selic** vem da API pública do Banco Central (atualizada pelo bot a cada
  poucas horas); o CDI é aproximado como Selic − 0,10 p.p. e o benchmark é
  **106% do CDI** com capitalização diária, como na renda fixa.
- **Ajustar a Selic e o % do CDI manualmente** (a partir da V6.5): ao lado dos
  botões Real/Simulação há dois campos — **Selic % a.a.** e **% do CDI** — e um
  botão **Salvar**. O que você digitar na Selic passa a valer no lugar da API do
  BCB (útil se quiser fixar a taxa ou testar cenários); **deixe o campo em
  branco e salve para voltar a usar a API**. O **% do CDI** troca o multiplicador
  do benchmark (padrão 106) — o título do card, a coluna e o rodapé passam a
  mostrar o valor que você escolheu. O bot aplica na próxima rodada (até ~15 min).
- A tabela mostra as taxas equivalentes **ao ano, ao mês, na semana e no
  período**, além do dinheiro: seu lucro real × quanto 106% do CDI teria
  rendido sobre o mesmo capital inicial.
- O "capital inicial" é o patrimônio real da plataforma quando a comparação
  começou. **Depósitos e saques depois disso distorcem o comparativo** — é um
  termômetro, não um extrato fiscal. Lucros em outras moedas (ex.: USD na
  Tastytrade) são convertidos para reais pela cotação do BCB e **somam** no
  total comparado com o CDI; o detalhe por moeda continua aparecendo separado.
- Os **% do robô** só aparecem depois da primeira análise em modo real (antes
  disso o bot ainda não conhece o capital inicial) e a anualização só é feita
  com pelo menos 1 dia de história.
- **Aba Real / Simulação** (a partir da V6.2): o mesmo card tem um botão para
  ver o comparativo da **simulação** — útil para avaliar a estratégia antes de
  arriscar dinheiro real. A simulação usa o patrimônio simulado como capital
  inicial e conta só o lucro dos ativos em simulação. A Selic/benchmark é a
  mesma nos dois.

---

## 6.2 "Se vender tudo agora" (lucro/prejuízo não realizado)

Na **Visão geral**, o tile **"Se vender tudo agora"** mostra quanto você
ficaria — já **descontadas as taxas de compra e venda** — se liquidasse TODAS
as posições abertas ao preço atual, neste instante. **Verde** = sobraria lucro;
**vermelho** = daria prejuízo. O total consolidado aparece em **reais** (moedas
estrangeiras convertidas pelo câmbio do BCB); a tabela de ativos traz a mesma
conta por ativo, na moeda de cada plataforma.

Pontos importantes para não confundir:

- **Considera todas as posições abertas, inclusive as no prejuízo.** Um lote no
  vermelho abate o lucro dos outros — o número é o resultado líquido da carteira
  inteira, não só das posições que já dão lucro.
- É **diferente do "Lucro total"** da tabela: aquele é o lucro **já realizado**
  (vendas que de fato aconteceram); este é o que ainda está **em aberto** ("no
  papel"), e muda a cada oscilação de preço.
- **Número vermelho NÃO significa que o robô vai vender.** Ele continua
  respeitando a regra "nunca vender no prejuízo" — só executa a venda de um lote
  quando ELE dá lucro. Este tile é um termômetro da sua exposição, não uma ordem.
- O valor é calculado pelo bot (mesma fórmula da regra de lucro), então só
  aparece depois que cada ativo passa por uma análise; antes disso fica em "—".

---

## 6.3 Controles rápidos (os quatro botões de emergência)

Na **Visão geral**, no fim da página (seção **Ajustes**), existe um cartão com
os quatro botões que desligam o robô — cada um desliga uma parte diferente.
Todos ficam juntos de propósito: na hora do aperto você não precisa procurar.

Todos pedem **confirmação**, todos são **reversíveis pelo mesmo botão**, e em
todos eles o bot **continua no ar** (aparece 🟢 online). Enquanto um estiver
ligado, um **banner** no topo da Visão geral lembra você disso.

| Botão | O que para | O que CONTINUA | Demora |
| :--- | :--- | :--- | :--- |
| ⛔ **Travar tudo** | tudo: nenhuma análise e nenhuma ordem, real ou simulação | só o heartbeat (o bot fica vivo) | ~1 min |
| 🧠 **Desligar IA** | a IA: nenhuma análise nova, nenhuma compra, nenhuma venda decidida por ela; a supervisão semanal fica pausada | **o stop-loss e a trava de lucro** — suas posições continuam protegidas | ~1 min |
| 🔕 **Desligar avisos** | as mensagens no Telegram | tudo o mais: o robô segue analisando e operando | ~5 min |
| 💰 **Ligar modo vendas** | as compras (o robô passa a liquidar a carteira) | as vendas — ver §6.6 antes de usar | ~1 min |

**Qual usar?**

- Algo muito errado (mercado maluco, notícia grave, robô estranho): **Travar
  tudo**.
- Quer só que ele pare de tomar decisões novas, mas sem largar as posições
  abertas sem proteção: **Desligar IA**. É o botão certo quando você quer
  "congelar a carteira como está" sem abrir mão do chão que já existe.
- Está em reunião/viagem e não quer o celular apitando: **Desligar avisos**.
  Suas escolhas de quais eventos avisar ficam intactas — religar devolve tudo
  como estava. Este é o mesmo interruptor do card "Avisos no Telegram".

⚠️ **Cuidado com o "Desligar avisos"**: um robô mudo parece um robô sem
problemas. Você deixa de receber inclusive os avisos de erro (quota da IA
acabou, corretora fora do ar). Por isso ele tem banner próprio na tela.

---

## 6.4 Validade do contexto (definida pela IA)

O **contexto** que você escreve para um ativo (notícias, cenário) ganhou prazo
de validade a partir da V6.2:

- Quando você salva um contexto novo, **a IA define, na análise seguinte, por
  quantos dias ele ainda é relevante** — notícia de curto prazo vale poucos
  dias; tese estrutural vale meses. Isso é decidido **uma vez** e não muda mais.
- O editor de contexto mostra o status: "a IA definirá a validade na próxima
  análise", depois "✓ válido até DD/MM", e por fim "⚠️ expirado".
- **Passada a validade, o contexto para de ser enviado à IA** — assim uma
  notícia velha não fica influenciando as decisões para sempre.
- Quer renovar ou trocar? **Reescreva o texto e salve**: isso zera a validade e
  a IA define um novo prazo na próxima análise.

---

## 6.4.1 Como o robô SAI de uma posição (a estratégia)

Isto explica por que você quase nunca vê a decisão "VENDER" na tela — e por que
**isso é o esperado**, não um defeito.

O robô tem **três formas de sair** de uma posição. Duas são automáticas e uma é
decisão da IA:

**1. O stop-loss (o chão largo) — corta o prejuízo.** Fica bem abaixo do preço,
de propósito, para aguentar o balanço normal do dia. Se o preço cair até ele, a
posição é vendida — inclusive no prejuízo. É a rede de segurança, não a tesoura.

**2. A trava de lucro (o chão estreito) — realiza o ganho.** Assim que a posição
sobe um pouco acima do ponto de empate, o robô arma um **segundo** chão, bem mais
perto do preço, logo abaixo do **topo** que aquela posição já alcançou. Se o
preço devolver essa distância, ele vende e embolsa o lucro.

> **A trava nunca vende no prejuízo.** Ela só existe acima do ponto de empate. No
> pior caso ela realiza um lucro menor do que daria para esperar — nunca uma
> perda.

**3. A venda decidida pela IA.** Ela tem duas horas certas:

- **Quando a trava ainda não armou** e o lote já está em lucro. Aí o ganho é
  pequeno demais para a trava, o stop-loss está lá embaixo e **nenhum automático
  reage** — se o preço virar, o lucro vira prejuízo. É a faixa mais importante
  da decisão dela.
- **Quando a tendência virou de vez** num lote com trava armada: vender agora
  entrega mais que esperar o preço devolver os 0,8%.

> **Por que isso mudou (V8.11, 05/08).** Até aqui a saída normal era só o chão
> largo subindo, e ele **nunca alcançava os lotes de verdade**: para começar a
> travar lucro, o preço precisava subir uns 5% a 6,7%, e o topo mediano das 23
> posições fechadas foi de **+1,09%**. Resultado: 17 saídas por stop contra 6
> vendas no lucro. A trava de lucro é a peça que faltava.

Você vê a trava de cada posição na coluna **"Trava de lucro"** da tabela de
posições abertas. "—" ali significa que ela ainda não armou.

---

## 6.5 Stop-loss — quando o robô vende no prejuízo (V6.6)

Até a V6.5 o sistema **jamais** vendia no prejuízo. A partir da V6.6 ele vende —
mas só em UMA situação, e quem decide **não é a IA**:

**Como funciona, em uma frase:** toda vez que a IA manda comprar, ela é obrigada
a dizer também qual é o **chão** daquela posição (o `stop-loss`) e **por quê**.
Se o preço tocar esse chão, o robô vende aquele lote automaticamente, aceitando
o prejuízo.

- **Quem dispara é o Motor de Regras**, sozinho, sem consultar a IA. A IA não
  consegue pedir para vender no prejuízo, nem consegue impedir um stop.
- **A checagem roda a cada ciclo** (~15 min), mesmo quando o preço mexeu pouco e
  a IA nem seria chamada. Um chão que só fosse conferido às vezes não protegeria.
- **É por posição, não pela carteira.** Se você tem 3 lotes e só um furou o
  chão dele, só esse é vendido. Os outros continuam intactos.
- **Posição sem chão nunca é vendida no prejuízo.** As que você comprou antes da
  V6.6, as `externas` (compra manual/depósito) e as `manuais` (Toro) nascem sem
  stop — elas seguem na regra antiga (só vendem no lucro) até a IA definir um
  chão para elas.
- **O chão só sobe, nunca desce.** Conforme o preço sobe, a IA pode elevar o
  stop para travar lucro ("trailing"). Se ela tentar **baixar**, o robô descarta
  o pedido — senão ela poderia empurrar o prejuízo com a barriga para sempre.
- **Teto de distância**: se a IA colocar um chão muito longe do preço (mais que
  a "Distância máxima do stop-loss" da config, padrão 15%), o robô **aperta** o
  valor até o limite. Um stop de -60% seria o mesmo que não ter stop.
- **Compra sem chão não acontece**: se a IA responder um `stop_loss` inválido, o
  Motor recusa a compra. A falha sempre trava a compra, nunca força uma venda.

### O robô sobe o chão sozinho quando a posição está em lucro

Isso é novo (2026-07-24) e é o que impede o lucro de evaporar enquanto você
espera a IA decidir vender.

- **Enquanto o lote está no lucro**, o Motor mantém o chão a uma distância fixa
  abaixo do preço e o **sobe a cada ciclo** (~15 min), sozinho. Se o preço sobe,
  o chão sobe junto; se o preço cai, o chão fica onde estava até ser tocado.
- **A distância é configurável e o número é SEU**: campo **"Folga do stop-loss
  (%)"** (`stop_loss_trailing_percentual`) na config do ativo, padrão **3%**. A
  IA pode pedir um valor próprio na compra, mas **só para ALARGAR** — se ela
  pedir menos que o seu, vale o seu (ver 6.5.1).
  - **Apertado demais** (ex.: 1% numa cripto): o balanço normal do dia estopa a
    posição antes de a alta acontecer.
  - **Largo demais** (ex.: 10% numa ação): o preço devolve quase todo o lucro
    antes de o chão ser tocado.
- **Nunca age numa posição fora do lucro.** Se o lote ainda não cobriu as taxas,
  o Motor não mexe no chão — ele respeita o que a IA escolheu na entrada.
- **Nunca para num preço que daria prejuízo.** Vender no preço que você pagou
  **não** é empatar: você paga taxa na compra E na venda. O robô nunca deixa o
  chão parar nessa faixa; ele o empurra até o primeiro preço que realmente dá
  lucro (o "preço mínimo de venda lucrativa" que aparece em cada posição).

> **Por que isso existe:** medimos o histórico real de uma posição de Petrobras.
> Foram 127 ciclos desde a compra, mas a IA só foi consultada ~20 vezes — e o
> chão se moveu **uma única vez**, enquanto o lucro caía a menos da metade do que
> tinha chegado a ser. Com o trailing automático a 3%, teria ficado em ~60% do
> pico em vez de ~40%.

### Onde você vê isso

- **Gráfico "Preço e operações"** (tela do ativo): agora tem **três** marcadores
  — ▲ amarelo = compra, ▼ azul = venda decidida pela IA, **▼ vermelho = venda
  por stop-loss**. A vermelha é a única que pode ter dado prejuízo.
- **Tabela de operações**: a linha aparece como **"VENDA (stop-loss)"**.
- **Lucro realizado** e as estatísticas incluem esses prejuízos normalmente —
  não existe contabilidade paralela.

> **O que esperar:** stop-loss faz o número de operações com prejuízo **subir** e
> a taxa de acerto **cair**. Isso é esperado e não é defeito: a troca é aceitar
> várias perdas pequenas e controladas para evitar uma perda grande. Se você vir
> muitos stops seguidos, o problema costuma estar no chão apertado demais ou no
> prompt do ativo — não no mecanismo.

### 6.5.1 A "folga" — o campo que resolve stop vendendo em prejuízo (V8.8)

Foi exatamente esse "muitos stops seguidos" que aconteceu, e em 29/07 medimos de
onde vinha. **Não era do stop-loss.** A IA abria a posição com um chão bom (3% a
6% abaixo do preço) e, poucas horas depois, subia esse chão até quase encostar no
preço — colando-o numa média móvel de 15 minutos. Aí qualquer balanço normal do
dia derrubava o lote no zero, pagando taxa duas vezes.

Os números: nos 13 stops com prejuízo antes do reset, **12 tinham chão posto pela
IA**. O chão que o robô sobe sozinho não causou nenhum. E nos 2 dias seguintes ao
reset, 13 lotes fecharam — **todos por stop, nenhum por lucro**.

**O que mudou:** agora existe uma **FOLGA** por ativo. É a distância mínima entre
o preço e qualquer chão. Um pedido mais perto que isso:

| Situação | O que o robô faz |
| :--- | :--- |
| A IA declara o chão na COMPRA colado no preço | **Alarga** até a folga e compra normalmente |
| A IA tenta apertar o chão de um lote que já tem chão | **Descarta** o pedido — o chão largo continua |
| A IA dá o primeiro chão a uma posição sem nenhum | **Alarga** até a folga (chão largo é melhor que nenhum) |

**A folga é o campo "Folga do stop-loss (%)"** na config de cada ativo — o mesmo
que antes se chamava "Distância do trailing". Você muda ali, ativo por ativo, e
**a IA não pode apertá-lo**: ela só consegue pedir mais espaço, nunca menos. Era
esse o furo — antes o número dela vencia o seu, e por isso subir a config não
mudava nada.

> **O preço dessa mudança:** menos stops, e cada um mais caro. Em troca, o lote
> deixa de morrer no zero e ganha espaço para a alta acontecer.

---

### 6.5.2 A trava de lucro — os dois campos novos (V8.11)

A folga de 5% resolveu o prejuízo e criou outro problema, que só apareceu quando
comparamos dois números: **para o chão largo começar a travar lucro, o preço
tinha de subir +6,7% no Mercado Bitcoin** (+5,5% na Binance, +5,3% na
Tastytrade) — e o topo mediano das 23 posições fechadas foi de **+1,09%**, com o
maior de todos em +3,07%. Nenhuma chegou perto. O chão subia, o robô "funcionava",
e nenhum centavo de lucro era travado.

**A causa:** um número só fazendo dois trabalhos opostos. O chão que protege do
prejuízo precisa ser LARGO. O que realiza lucro precisa ser ESTREITO. Agora são
dois números separados, e você ajusta cada um por ativo:

| Campo | Padrão | O que faz |
| :--- | :--- | :--- |
| **Folga do stop-loss (%)** | 2% | distância do chão largo, o que corta prejuízo |
| **Trava de lucro — gatilho (%)** | 1% | quanto a posição precisa subir acima do ponto de empate para a trava armar |
| **Trava de lucro — devolução (%)** | 0,8% | quanto do TOPO o robô aceita devolver antes de vender |

**Como ler isso na prática.** Você comprou a 100 e o ponto de empate é 101,4
(taxas das duas pernas). A trava arma quando o preço passa de ~102,4 (empate +
1%). Se o preço chegar a 110, a trava fica em 109,12 (110 − 0,8%). Caiu para
109,12 → vende, com lucro. Subiu para 115 → a trava sobe para 114,08. **Ela só
sobe.**

**Como ajustar:**

- Quer **realizar mais cedo e mais vezes**? Diminua a devolução (0,5%).
- Quer **deixar correr mais**? Aumente a devolução (1,5% ou 2%).
- Quer **desligar a trava** num ativo? Ponha **0** em qualquer um dos dois
  campos — ele volta a se comportar como antes.

> **O que esperar:** mais vendas, cada uma com lucro menor. É de propósito. O
> quadro anterior era 17 saídas por stop (todas no vermelho) contra 6 vendas no
> lucro.

---

## 6.6 Modo vendas — liquidar a carteira (V8)

**Para quê:** quando você quer **encerrar as posições** — parar de operar, sacar
o dinheiro, trocar de estratégia, resetar tudo. O robô para de comprar e passa a
procurar a melhor SAÍDA para o que já está aberto.

**Onde:** Visão geral → cartão *"Modo vendas (liquidação)"*. Dois campos e um
botão.

### Como funciona o prazo

Você define uma **janela** (padrão 7 dias) e um **prejuízo máximo** (padrão 15%).
O robô não vende tudo de uma vez: a tolerância a prejuízo **abre aos poucos**.

| Dia | Prejuízo aceito por posição |
| :--- | :--- |
| 1 | **0%** — só vende no lucro, igual ao normal |
| 2 | 2,5% |
| 3 | 5% |
| 4 | 7,5% |
| 5 | 10% |
| 6 | 12,5% |
| 7 | 15% (o teto que você configurou) |
| 8 em diante | continua em 15% |

A ideia: **no começo você tem tempo**, então uma posição temporariamente afundada
pode virar lucro; **no fim você tem urgência**, então a tolerância abre. Isso é o
que impede a IA de despejar a carteira no pior preço logo na primeira hora.

### O que muda enquanto está ligado

- **Nenhuma compra é aceita** — o Motor rejeita, mesmo que a IA insista.
- **A IA recebe um prompt diferente**: em vez das regras normais, as *regras do
  modo vendas* (editáveis em "Regras gerais da IA", logo abaixo das normais).
- **O supervisor semanal fica pausado** — ele analisa decisões de compra, que
  agora não existem. Volta sozinho quando você desliga.
- **O stop-loss continua ativo**, protegendo o que ainda não foi vendido.
- Banner permanente na Visão geral com o dia e a tolerância de hoje, e um
  lembrete por dia no Telegram.

### Onde aparece

- Gráfico da tela do ativo: **▼ dourado = venda na liquidação**.
- Tabela de operações: **"VENDA (liquidação, dia N)"**.
- Telegram: *"Venda na liquidação (dia N/7)"*.

> ⚠️ **O modo NÃO desliga sozinho.** Passados os 7 dias ele continua valendo com
> a tolerância no teto — é você que precisa desligá-lo no botão. O lembrete
> diário do Telegram passa a cobrar isso depois da janela.

> ⚠️ **Lote muito afundado não é vendido.** Se um lote está 40% no vermelho e o
> teto é 15%, ele **não sai** — a regra de nunca vender no prejuízo continua
> valendo para ele. Para liquidar mesmo assim, aumente o campo "Prejuízo máximo"
> e salve.

**Para voltar ao normal:** clique em "▶ Desligar modo vendas". As compras voltam,
o prompt normal volta, o supervisor volta. Se você religar depois, a contagem
recomeça do **dia 1** (tolerância zero) — nunca do meio da rampa antiga.

---

## 7. Custos: depósito × comissão (não confundir!)

São coisas diferentes e **não podem ser misturadas**:

- **Comissão de trade** (compra/venda dentro da corretora): cobrada em **toda
  operação**. É o que vai nos campos de taxa.
- **Custo de depósito** (ex.: taxa de transferir dinheiro para a corretora):
  pago **uma vez**, quando você transfere. **NÃO** é taxa de trade.

**Por que não colocar o custo de depósito nas taxas?** Porque as taxas são
cobradas em cada operação. Se você puser o custo do depósito ali, o robô vai
"recobrá-lo" em cada compra e venda — um custo que você pagou só uma vez. Ele
ficaria paralisado (exigindo lucros irreais para vender) e os números de lucro
ficariam errados.

**Onde esse custo "mora", então?** No seu saldo, que já entrou menor. Você
transferiu X, chegou X − taxa, e o robô opera com o que chegou. É um corte no
principal, não um custo por operação. Para reduzir, o caminho é usar formas de
depósito mais baratas — não mexer na configuração do robô.

---

## 8. Toro — modo assistido (ações e FIIs da B3)

A Toro **não tem API** — o robô não consegue nem ler sua conta, muito menos
enviar ordem. Por isso a plataforma TORO funciona em **modo assistido**:

1. **Você informa o que tem** — caixa e operações (passos abaixo).
2. **O robô analisa sozinho** — cotações e candles **diários** da B3 vêm da
   API pública **brapi.dev**; os indicadores e a IA funcionam como nas outras
   plataformas (swing trade: 1 análise por hora, dentro do pregão).
3. **O robô RECOMENDA, você executa** — quando a IA decide comprar/vender e o
   Motor de Regras aprova (as regras valem iguais: nunca recomenda vender
   posição no prejuízo), aparece o card **"📣 Recomendação para você
   executar"** na tela do ativo. Se concordar, execute no app da Toro.
4. **Você registra o que fez** — formulário **"Registrar operação manual"**
   na tela do ativo (tipo, quantidade, preço, data e taxa opcional). O robô
   aplica no próximo ciclo: compra vira posição com o SEU preço de custo;
   venda realiza o lucro (ou prejuízo — registrar a verdade é o que importa).

### 8.1 Primeira configuração da Toro (uma vez só)

1. Crie um token gratuito em **brapi.dev** (Dashboard → token).
2. Na dashboard → **Plataforma Toro (modo assistido)** → cole o **token do
   brapi.dev** e a **API Key da IA** (a mesma do Gemini).
3. No card **"Caixa da corretora (manual)"**, informe quanto dinheiro você tem
   disponível na Toro — é a base das recomendações de compra (orçamento).
4. Cadastre os tickers que você acompanha (seção 4) e, para cada um: defina o
   **orçamento (%)** e **ligue** o ativo.
5. Se você JÁ tem as ações: registre uma **COMPRA manual** com a quantidade e
   o seu **preço médio real** (está no app da Toro) — assim o robô conhece o
   seu custo e a régua do lucro fica certa.

### 8.2 Como o dinheiro se mantém certo

- O **caixa manual** é debitado/creditado sozinho a cada operação registrada e
  a cada dividendo. Só edite o valor de novo se fizer um aporte/retirada na
  corretora.
- **Dividendos e JCP entram sozinhos**: 1× por dia o robô consulta os
  proventos do ticker (brapi), registra os pagos desde a abertura da sua
  posição como operação `DIVIDENDO`, soma no lucro e credita o caixa.
  *Aproximação*: o cálculo usa a quantidade ATUAL em carteira (não a da
  data-com) — para quem compra e segura, a diferença é pequena; se quiser
  precisão absoluta, confira o valor no app da Toro e ajuste o caixa.
- As operações registradas são consideradas **REAIS** (você as executou de
  verdade): o lucro entra nas estatísticas reais e no comparativo
  **Rendimento real × 106% do CDI** da visão geral.

### 8.3 O que o modo assistido NUNCA faz

- Enviar, agendar ou simular ordem na Toro (não existe caminho técnico).
- Recomendar venda de posição no prejuízo (regra imutável do Motor).
- Apagar registros seus: pedidos com erro ficam marcados (não somem) e você
  pode registrar de novo.

> Recomendações **expiram sozinhas**: se a análise seguinte decidir AGUARDAR,
> o card some — você nunca age numa sugestão velha com preço defasado.

---

## 8.4 Steam — skins do CS2 (modo assistido)

A Steam **tem API para LER** (preço e inventário) e **nenhuma para comprar ou
vender**. Automatizar a compra exigiria dar ao robô o cookie da sua conta, o que
arrisca a conta — então aqui ele **só analisa e recomenda**, e quem executa é
você, no site da Steam. Tudo fica na tela **🎮 Steam** do menu.

**Antes de começar, duas coisas do seu lado:**

1. Deixe o **inventário do CS2 público** no perfil da Steam (Perfil → Editar →
   Privacidade → Inventário: Público). Sem isso o robô não enxerga nada.
2. Pegue o seu **SteamID64** — é o número de 17 dígitos que aparece na URL do
   seu perfil — e cole no campo da seção Steam.

### O que você vê e o que decide

- **Todos os itens do inventário aparecem**, com foto, quantidade e preço atual.
  O total soma só os que têm preço no mercado.
- **O check "analisar com IA" é seu controle de custo.** Marcado, o item vira um
  ativo de verdade: a IA analisa, recomenda e o histórico dele começa. Não
  marcado, ele fica só mostrando o valor, sem gastar nada. Desmarcar apenas
  desliga — o histórico do item continua guardado.
- **Os três tempos** (análise, preços, atualizações do CS2) são separados porque
  custam coisas diferentes: análise gasta IA; preço gasta uma consulta por item
  (a Steam corta quem passa de ~20 por minuto); procurar update é uma consulta
  só. Mínimo de 15 minutos em cada.

### O número que mais importa: a taxa é ~15%

A Steam cobra ~15% na venda. Você compra um item por R$ 100 e **só volta ao zero
a zero se vender por R$ 115**. Não existe operação rápida que pague essa conta —
por isso o prompt da Steam manda mirar em pelo menos +20%, e "AGUARDAR" é a
resposta certa quase sempre. Ficar parado custa zero; girar custa caro.

Outro ponto: **o dinheiro fica preso na carteira Steam** (não dá para sacar). Por
isso ele NÃO entra no seu patrimônio consolidado nem no comparativo com o CDI —
seria misturar dinheiro que você pode usar com dinheiro que você não pode.

### Atualizações do CS2 e alertas de preço

- **O robô acompanha os anúncios oficiais do jogo.** Quando sai um update, chega
  aviso no Telegram e a nota vai para a análise da IA. Num mercado de skin isso
  pesa mais que qualquer indicador: case nova, operação e mudança de drop movem
  o preço. Uma notícia nova também força uma análise na hora, mesmo que o preço
  ainda não tenha se mexido.
- **Alerta de preço-alvo**: escolha um item, defina "avise se cair abaixo de X"
  e/ou "se subir acima de Y". Funciona para **qualquer** item, marcado ou não, e
  não gasta IA. O aviso sai **uma vez por travessia**: item parado abaixo do
  alvo não vira mensagem toda hora, e o alerta se rearma sozinho quando o preço
  volta.

### Registrar o que você comprou ou vendeu

Igual à Toro: no card do item marcado, clique em **"ver análise e registrar
operação →"**. Lá estão a recomendação da IA, as posições abertas e o formulário
de registro. Registre com o preço que você de fato pagou — é ele que define se a
venda dá lucro.

**O que o robô NUNCA faz aqui:** enviar ordem. Nem compra, nem venda, nem por
engano — o código recusa a operação antes de tentar.

### Por que não tem gráfico de RSI, MACD e afins

Porque este mercado não fornece histórico de preço. O robô então **guarda o preço
a cada coleta e monta a série sozinho**: em um dia ele já compara com ontem, em
uma semana com a semana passada. Enquanto uma janela não estiver coberta, ela
aparece como desconhecida — nunca como "0%", que seria mentira.

## 8.5 Avisos no Telegram

O robô te manda mensagem quando algo acontece. **Não usa IA** — é só formatação
dos dados que o sistema já tem, então não consome quota nenhuma.

### Como configurar (uma vez só)

1. No Telegram, procure **@BotFather** e mande `/newbot`.
2. Escolha um nome (ex.: `IA Investidora`) e um usuário terminado em `bot`
   (ex.: `ia_investidora_rodrigo_bot`).
3. O BotFather responde com o **token** — algo como
   `8123456789:AAF...`. **Esse token é uma senha**: quem o tiver manda mensagem
   como se fosse o seu bot.
4. **Abra a conversa com o SEU bot novo e mande "oi"** (ou clique em *Iniciar*).
   **Não pule este passo**: sem ele o Telegram não deixa o bot te escrever, e o
   passo 5 volta vazio.
5. Abra no navegador: `https://api.telegram.org/bot<SEU_TOKEN>/getUpdates`
   (troque `<SEU_TOKEN>` pelo token inteiro). Procure `"chat":{"id":123456789` —
   esse número é o seu **chat id**.

   > ⚠️ **É o id da SUA conversa, não o do bot.** Se o `getUpdates` vier vazio
   > (porque você pulou o passo 4) é tentador pegar o número que aparece em
   > outro lugar — mas esse costuma ser o id do próprio bot, e aí ele tenta
   > mandar mensagem para si mesmo. O Telegram recusa com
   > *"the bot can't send messages to the bot"*. Volte ao passo 4.

6. Na dashboard → **Visão geral** → card **Avisos no Telegram**: cole o token e o
   chat id, marque **Ligado**, escolha os eventos e **Salvar**.

**Em até 5 minutos** você recebe *"✅ Avisos ligados"* no Telegram. O atraso é o
cache de configuração de 5 min (§5).

**Se não chegar**, o próprio card mostra o que houve: uma linha
*"❌ Último envio falhou: …"* com a mensagem exata do Telegram (ex.: *chat not
found*, *the bot can't send messages to the bot*). Esse texto diz o que corrigir.

### O que você recebe

| Evento | Mensagem |
| :--- | :--- |
| **Venda** | Ativo, quantidade, preço e o **resultado** (+ ou −). Venda por stop-loss vem marcada como tal, com o motivo do chão. |
| **Compra** | Ativo, quantidade, preço e total. |
| **Recomendação (Toro)** | O que executar na corretora e por quê. **É o aviso mais importante do modo assistido**: sem ele, a recomendação nasce e expira em ~15 min sem você ver. |
| **Problemas** | Quota da IA esgotada, corretora fora do ar. No máximo **1 aviso por dia** de cada problema (senão a quota esgotada avisaria a cada ciclo). Quando volta ao normal, você recebe um "✅". |

Operações em **simulação** vêm marcadas com *(simulação)* — o aviso não deixa
você confundir dinheiro de verdade com teste.

### Detalhes que importam

- **O token nunca volta para a tela.** Depois de salvo, o campo aparece vazio;
  deixar em branco mantém o que já está gravado. Para trocar, cole um novo.
- **Aviso nunca atrapalha o robô.** Se o Telegram estiver fora do ar ou o token
  errado, a operação acontece do mesmo jeito — a falha só vira um aviso no log.
- **Desligar**: desmarque *Ligado* e salve. Nada mais é enviado.
- Se quiser parar só um tipo de aviso (ex.: compras, que são as mais
  frequentes), desmarque só ele.

---

## 8.6 Relatório de decisões (semanal)

A cada 7 dias o robô mede as próprias decisões e manda um resumo no Telegram
(também fica na Visão geral, card **Relatório de decisões**). **Não usa IA** —
é contagem dos dados que já existem.

| O que mostra | Como ler |
| :--- | :--- |
| **Decisões da IA** | Quantas análises houve e quantas viraram ação. "Agiu em 2,7%" significa que em 97% das vezes a resposta foi `AGUARDAR` — o que pode ser disciplina ou paralisia, dependendo do resto. |
| **Posições fechadas** | Separadas por motivo: **realização (IA)** × **stop-loss (Motor)** × registro manual. É a pergunta central: as saídas estão sendo escolhas ou defesas? |
| **Resultado realizado** | Lucro do período e **quanto foi para taxas**, por moeda (nunca somadas entre si). Vale comparar os dois: taxa maior que o lucro significa giro demais para o tamanho do movimento capturado. |
| **Risco:retorno** | Quanto cada lote ganhou por unidade de risco aceita na entrada. **Abaixo de 1×** o lote rendeu menos do que arriscou; a assimetria que as regras gerais pregam pede mediana bem acima de 1. |

Estes mesmos números são a matéria-prima da **supervisão semanal** (seção 8.7),
que os interpreta e escreve a correção no prompt do analista.

**O primeiro relatório sai 7 dias depois de o robô subir com o recurso** — a
primeira execução só marca o início da janela, para não mandar um resumo
parcial. Posições abertas antes de 2026-07-25 não entram na conta de
risco:retorno (o chão inicial delas não foi gravado).

---

## 8.7 Supervisão semanal — a IA que corrige a IA (V7.2)

Uma vez por semana, um **segundo agente de IA** lê tudo o que o analista fez —
as decisões, as justificativas, as posições que abriu, como elas fecharam, o
dinheiro e as taxas — e escreve um texto curto que passa a ser **enviado ao
analista em toda análise**, junto das regras gerais.

É a diferença entre um robô que repete o mesmo erro por semanas e um que
percebe o erro e se corrige. O episódio da PBR (o robô viu o lucro e não
vendeu, por 37 análises seguidas) só apareceu porque você estranhou um número.

**O que ele pode e o que ele não pode**

| Pode | Não pode |
| :--- | :--- |
| Escrever a camada de prompt (só ela) | Comprar, vender ou mexer em qualquer posição |
| Comentar posições abertas (para VOCÊ ler) | Mexer no stop-loss ou em qualquer configuração |
| Mudar o próprio texto toda semana | Reescrever as regras gerais, o template ou o prompt que VOCÊ escreveu |
| Sugerir que o analista mude de postura | Mudar o formato da resposta do analista ou revogar as regras gerais |

As três últimas linhas não dependem de boa vontade dele: o sistema **recusa** a
versão inteira se ela tentar, e nesse caso a camada da semana anterior continua
valendo.

**A tela** (menu → *Supervisão semanal*)

- **Diagnóstico da última rodada** — o resumo em português do que ele achou.
- **O que mudou no prompt do analista** — a lista das alterações, com o porquê.
- **Observações sobre posições abertas** — os palpites dele; são para você ler,
  não viram ordem.
- **Camada em vigor** — o texto que o analista está recebendo. Você pode
  **editar à mão**; vale até a próxima rodada, que reescreve.
- **Versões anteriores** — as 5 últimas, com **Restaurar** (carrega no editor;
  você confirma no *Salvar camada*).
- **Instruções do supervisor** — o prompt do próprio supervisor: o que ele deve
  procurar e como deve escrever.

**Botões importantes**

- **"Enviar esta camada ao analista"** — desmarcar é o freio de mão: o agente
  para de rodar **e** o analista deixa de receber a camada, em até 5 minutos.
  Nada é apagado; remarcar devolve exatamente o que estava valendo.
- **"▶ Rodar agora"** — não espera a semana virar. Útil para ver o recurso
  funcionando sem esperar 7 dias. O bot executa no próximo minuto e o resultado
  aparece na tela e no Telegram.

**Quando ele roda sozinho:** 1×/semana, de madrugada (o horário em que a cota
gratuita do Gemini renova) — assim ele usa o modelo mais forte com a cota
inteira, sem disputar com o analista, que roda o dia todo. Reiniciar o bot não
adianta nem atrasa a próxima rodada.

**Se a IA estiver fora do ar ou responder besteira:** nada acontece. A camada
anterior continua valendo e você recebe o motivo no log. O modo de falha é o
prompt do analista **não mudar** — nunca o contrário.

> **Vale desconfiar nas primeiras semanas.** Sete dias de operação são poucos
> dados, e o próprio prompt do supervisor manda ele preferir não mudar nada
> quando a amostra é pequena. Leia o "o que mudou" antes de deixar rodando
> sozinho por muito tempo.

---

## 8.8 Resetar tudo e recomeçar do zero

Depois de muitas mudanças de prompt e de regra, os dados acumulados descrevem
várias versões diferentes do robô ao mesmo tempo — e param de responder qualquer
coisa. O reset apaga o histórico de operação e recomeça a medição limpa.

**Não dá para fazer isso pelo painel.** São ~7.500 registros espalhados, e
apagar à mão sempre deixa resto — que é justamente o que estraga a medição nova.

**Como rodar** (no PC, na pasta do projeto):

```bash
# 1. Só olhar o que aconteceria (não escreve NADA)
node scripts/resetar-dados.mjs

# 2. Executar de verdade, já semeando o caixa de cada corretora
node scripts/resetar-dados.mjs --executar --caixa MB=1000,BN=1000,TT=700
```

Precisa da variável `FIREBASE_SERVICE_ACCOUNT_PATH` apontando para o JSON da
service account (o mesmo arquivo que o bot usa).

**O que ele faz, nessa ordem:**

1. **Trava a operação** e espera o bot confirmar. Sem isso, uma análise em
   andamento escreveria no meio do reset.
2. **Salva um backup** em `backup_reset_<data>.json` na pasta do projeto.
3. **Apaga** histórico, operações, posições, estatísticas e o estado de cada
   ativo; zera a carteira virtual e o comparativo × CDI.
4. **Semeia o caixa** que você informou.
5. **Deixa travado de propósito.** Você confere a dashboard e destrava no botão.

**O que ele NÃO apaga:**

- Os **prompts** (regras gerais, prompt de cada ativo, contexto). Só saem se
  você passar `--resetar-prompts`.
- As **configurações** dos ativos (orçamento, taxas, intervalos, ligado/desligado).
- As **chaves de API**.
- A **Toro**, que fica de fora por padrão. Ela é assistida e em modo real: as
  posições dela são papéis que você tem de verdade na corretora, e apagá-las sem
  você ter vendido desencontraria o sistema da realidade. Para incluí-la,
  `--incluir-toro` — e mesmo assim o caixa e os saldos que você informou à mão
  são preservados.

> **Antes de resetar**, confira a lista de pendências no `ROADMAP.md`. A ideia do
> reset é medir um sistema pronto: se ainda falta mudar comportamento do robô, é
> melhor mudar antes e resetar depois, senão você mede o robô velho.

---

## 9. Excluir ativo

**Excluir um ativo de verdade** (tela do ativo → **Zona de risco** →
*Excluir este ativo*): apaga config, histórico, operações e posições **para
sempre**. Só funciona com o ativo **desligado**, e pede para você **digitar o
id do ativo** para confirmar.

---

## 10. Quando dá erro (troubleshooting)

| Sintoma | O que é / o que fazer |
|---|---|
| Nada acontece ao rodar `npm start` | Veja o console: a linha "orquestrador ... iniciado" tem que aparecer. Se não, provável `.env`/credenciais do Firebase. |
| Ativo parado (sem análises novas) | Confira: o ativo está **LIGADO**? O bot do Render está no ar (endpoint de saúde respondendo / pinger ativo)? A quota diária da IA pode ter esgotado — renova à meia-noite (horário do Pacífico). |
| Decisões da IA sempre "AGUARDAR" | Normal em mercado parado. Confira também a **variação mínima** (se alta demais, a IA quase não é chamada). |
| Compra rejeitada por orçamento | O ativo está no teto do **orçamento (%)** ou o orçamento é 0. Ajuste na config. |
| Tastytrade com ❌ no status | Veja o horário e a mensagem: se o teste rodou ANTES de você salvar as chaves, é só esperar (após uma falha o bot retesta a cada 5 min). Se persistir: as chaves OAuth estão erradas/faltando (seção 4.1) ou o grant foi revogado no site da corretora — gere um novo Refresh Token e cole na dashboard. Confira também se cada campo mostra "configurada (…)" no placeholder. |
| Ação da Tastytrade "parada" durante o dia | Provável pregão fechado (feriado nos EUA ou fuso). Veja o status do mercado na tela da plataforma — mostra a próxima abertura. |
| Salvei uma configuração e o robô "não obedeceu" | O robô relê as configurações a cada **5 minutos** (V5.2, seção 5). Espere até 5 min; se depois disso continuar ignorando, aí sim investigue. |
| Toro sem análises / "falha ao coletar preço" | Confira o **token do brapi.dev** na tela da plataforma (campo deve mostrar "configurada (…)"), se o ticker existe na B3 e se está dentro do pregão (seg–sex, 10h–18h). O plano gratuito da brapi tem limite diário — se estourar, aumente o tempo entre análises dos ativos TORO. |
| Registrei uma operação manual e "nada aconteceu" | O robô drena a fila **no próximo ciclo do ativo** (com o intervalo padrão de 60 min, pode demorar até 1h; o ativo precisa estar LIGADO e dentro do pregão). Se o pedido tiver erro (ex.: quantidade 0), ele é marcado e ignorado — registre de novo com os valores certos. |

---

## 11. Segurança

- **Chaves de API nunca vão para o código** — só no Firestore (produção) ou no
  `.env` local (que não é versionado).
- **Só a sua conta** acessa a dashboard (login + regra no servidor).
- **A dashboard grava chaves, mas não consegue lê-las** (desde 2026-07-25). Você
  cola uma credencial nova e ela vai para o servidor; puxar uma de volta é
  proibido pelo próprio Firestore, mesmo estando logado como você. Antes disso o
  navegador baixava as chaves inteiras e apenas *escondia* na tela — quem
  abrisse as ferramentas de desenvolvedor via tudo.

  Na prática, para você muda uma coisa só: **não dá mais para "conferir" uma
  chave já salva**. O campo mostra `configurada (…1234)` e, se precisar trocar,
  cole a nova por cima. Isso vale para as chaves das corretoras, a do Gemini, o
  token do brapi e o token do bot do Telegram.
- **Se você um dia tornar o repositório público**, nada muda: as chaves nunca
  estiveram nele.
