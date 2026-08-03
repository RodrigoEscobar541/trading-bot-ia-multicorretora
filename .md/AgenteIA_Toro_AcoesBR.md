# Toro / B3 — peculiaridades desta plataforma

Ações e FIIs da bolsa brasileira (B3), em **BRL**.

## Modo assistido: sua decisão não vira ordem automática

Esta é a diferença mais importante desta plataforma. A Toro não tem API de execução: o que você decide vira uma **recomendação** que o dono lê e executa manualmente na corretora — possivelmente **horas depois**, e só dentro do pregão.

Consequências diretas para a sua análise:

- **O preço de execução será diferente do preço que você analisou.** Não conte com precisão de centavos nem com timing fino.
- **Setups que dependem de reagir em minutos não funcionam aqui.** Prefira teses que continuem válidas amanhã.
- Margens apertadas de decisão — "vale a pena por pouco" — tendem a evaporar na defasagem. Aqui a tese precisa de folga.

## Horizonte diário (swing), não intradiário

A análise desta plataforma é feita sobre candles **diários**: cada dado representa um pregão inteiro, não minutos. Um movimento "recente" aqui são dias ou semanas, e uma posição é pensada em semanas ou meses. Raciocínio de curto prazo não se aplica.

## Pregão com horário fixo e gap overnight

Ao contrário de cripto, a B3 abre e fecha. Fora do pregão o preço simplesmente não anda — e na abertura seguinte pode **saltar** para outro patamar (gap), sem passar pelos preços intermediários. Toda posição mantida de um dia para o outro dorme exposta a esse salto.

## Custo baixíssimo

A corretagem da Toro é zero; sobram os emolumentos da B3, em torno de **0,03% por perna** — algo como 0,06% na ida e volta. Custo praticamente não é obstáculo aqui, ao contrário do que acontece em cripto. O que limita a frequência nesta plataforma não é a taxa: é o modo assistido e o horizonte diário.

## Ações inteiras

Não há fração: a menor operação é **1 ação**. Em papéis de preço alto, isso torna o tamanho da posição granuloso — pode não existir um tamanho intermediário entre "pouco" e "demais".

## Comportamento do mercado brasileiro

A B3 é **menos direcional** que as bolsas americanas: tem mais repiques, mais rompimentos falsos e mais movimentos que tiram o stop do varejo antes de retomar a direção original. Tendências longas e limpas são menos frequentes; períodos de vaivém são mais. Isso pede paciência maior e desconfiança de rompimentos ainda não consolidados.

## Liquidez concentrada em poucos nomes

Um punhado de papéis (grandes bancos, commodities, o ETF do índice) concentra quase todo o volume. Fora desse núcleo, o livro é fino: o preço se manipula com facilidade e o spread pesa.

## Somente comprado

Neste sistema só se compra e depois se vende o que se possui. Vender a descoberto na B3 exigiria aluguel de ativos, que não faz parte da operação. "Realizar na alta" significa vender uma posição existente.

## Proventos

Ações e FIIs pagam dividendos e JCP. Eles são registrados à parte, como renda informativa, e **não** entram no lucro das operações — não os considere ao avaliar o resultado de uma posição. Na data-ex o preço da ação cai aproximadamente o valor do provento: essa queda é contábil, não deterioração da tese.
