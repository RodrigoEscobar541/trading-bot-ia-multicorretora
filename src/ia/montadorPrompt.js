// montadorPrompt.js — monta o prompt de sistema enviado à IA (V2_Plan.MD §prompt):
//
//   Prompt Final = Regras gerais (globais, valem para tudo — SEMPRE primeiro)
//                + Template da plataforma
//                + Identidade do ativo (manifest)
//                + Prompt específico do ativo
//                + Supervisão semanal (escrita pelo agente supervisor — V7.2)
//                + Contexto do usuário (com a data em que foi escrito)
//
// MODO VENDAS (V8): com a liquidação ligada, a 1ª camada é SUBSTITUÍDA pelas
// regras de liquidação (`.md/regras_gerais_venda.md`) — nunca somada a elas —,
// entra um bloco com o dia e a tolerância de hoje, e a camada do supervisor sai
// (ela audita decisões de ENTRADA e não se aplica a quem está saindo).
//
// Indicadores, posições e histórico NÃO entram aqui: eles viajam no JSON do
// cenário (mensagem do usuário), calculados pelo código — a IA nunca calcula
// (regras.md §1.1). Módulo puro: sem rede, sem persistência.
//
// O manifest controla a composição (o núcleo não pergunta "é Bitcoin?"):
//   usaTemplatePlataforma — inclui o template da plataforma
//   usaPromptPersonalizado — inclui o prompt do ativo
//   usaSupervisao — inclui a camada da supervisão semanal (padrão: sim)
//   usaContexto — inclui o contexto do usuário
// As REGRAS GERAIS não têm flag: entram sempre (são a constituição da IA).

import { readFileSync } from 'node:fs';
import { recortarSupervisao } from './validadorSupervisao.js';

// Sementes de segurança: se o doc correspondente estiver vazio no Firestore
// (nunca deveria após a semeadura), o arquivo do repo assume.
let sementeTemplate = null;
function templateSemente() {
  sementeTemplate ??= readFileSync(new URL('./promptBase.md', import.meta.url), 'utf8');
  return sementeTemplate;
}
let sementeRegras = null;
function regrasGeraisSemente() {
  sementeRegras ??= readFileSync(new URL('../../.md/regras_gerais.md', import.meta.url), 'utf8');
  return sementeRegras;
}
let sementeRegrasVenda = null;
function regrasGeraisVendaSemente() {
  sementeRegrasVenda ??= readFileSync(new URL('../../.md/regras_gerais_venda.md', import.meta.url), 'utf8');
  return sementeRegrasVenda;
}

const SEPARADOR = '\n\n---\n\n';

// CONTRATO DE SAÍDA CANÔNICO — anexado SEMPRE por último, não editável pela
// dashboard. O código (validadorResposta.js) só aceita o campo `acao` ∈
// {COMPRAR, VENDER, AGUARDAR}; qualquer outro nome/vocabulário (ex.: `action`,
// `decisao`, `NO_TRADE`, `BUY`) reprova a resposta e vira AGUARDAR forçado.
// Como os templates/regras são editáveis e podem introduzir vocabulário
// concorrente, este bloco vem por ÚLTIMO e é a palavra final sobre o FORMATO —
// blindando o schema contra qualquer edição de prompt (o incidente de
// 2026-07-19: templates reescritos perderam a seção de formato → a IA passou a
// responder `{"decisao": ...}` e 100% das respostas foram rejeitadas).
const CONTRATO_SAIDA = [
  '# Formato de saída (OBRIGATÓRIO — prevalece sobre tudo acima)',
  '',
  'Independentemente de qualquer termo usado nas seções anteriores (por exemplo',
  '`NO_TRADE`, `WAITING`, `HALT`, `action`, `decisao`, `BUY`/`SELL`), sua ÚNICA',
  'saída é EXATAMENTE este JSON, sem markdown, sem comentários, sem texto fora',
  'do JSON. O nome do campo da ação é obrigatoriamente `acao` (nunca `decisao`',
  'nem `action`):',
  '',
  '```json',
  '{',
  '  "acao": "COMPRAR",',
  '  "percentual": 35,',
  '  "stop_loss": 332500.00,',
  '  "stop_loss_motivo": "Abaixo do fundo recente e da MM50 — perder esse nível invalida a tese de alta.",',
  '  "trailing_percentual": 3,',
  '  "confianca": 87,',
  '  "justificativa": "Uma ou duas frases curtas, em português, citando os indicadores que sustentam a decisão."',
  '}',
  '```',
  '',
  'Em `VENDER`, inclua também a lista de posições a vender:',
  '',
  '```json',
  '{',
  '  "acao": "VENDER",',
  '  "percentual": 0,',
  '  "posicoes": ["pos_20260712_145839"],',
  '  "confianca": 82,',
  '  "justificativa": "RSI em sobrecompra e a posição com lucro líquido positivo — realização."',
  '}',
  '```',
  '',
  'Regras do formato:',
  '- `acao` — exatamente `"COMPRAR"`, `"VENDER"` ou `"AGUARDAR"` (em maiúsculas).',
  '  Mapeie qualquer conceito equivalente: ficar de fora / `NO_TRADE` / `WAITING`',
  '  / `HALT` → `"AGUARDAR"`; comprar/`BUY` → `"COMPRAR"`; realizar/vender/`SELL`',
  '  → `"VENDER"`.',
  '- `percentual` — inteiro de 1 a 100 em `COMPRAR`; `0` em `VENDER` e `AGUARDAR`.',
  '- `posicoes` — obrigatório em `VENDER`: lista com um ou mais `id`s copiados de',
  '  `carteira.posicoes_abertas`. Ausente nas demais ações.',
  '- `stop_loss` — OBRIGATÓRIO em `COMPRAR`: o preço-CHÃO da posição que você está',
  '  abrindo, em número absoluto (não percentual), sempre ABAIXO do preço atual.',
  '  Se o preço tocar esse valor, o sistema vende a posição automaticamente,',
  '  ACEITANDO O PREJUÍZO — é a sua defesa contra a tese dar errado. Escolha um',
  '  nível técnico (fundo recente, média móvel relevante), não um número redondo',
  '  arbitrário. Compra sem `stop_loss` válido é recusada pelo sistema.',
  '- `stop_loss_motivo` — OBRIGATÓRIO em `COMPRAR`: uma frase curta explicando por',
  '  que o chão é nesse preço (que suporte/nível ele respeita).',
  '- `trailing_percentual` — OPCIONAL em `COMPRAR`: número > 0 (percentual). A',
  '  distância que o sistema manterá entre o preço e o chão ENQUANTO a posição',
  '  estiver em lucro, subindo o chão sozinho a cada ciclo (trailing automático).',
  '  Calibre pela `volatilidade_24h` do ativo, como faz com o `stop_loss`:',
  '  apertado demais, o ruído normal do dia stopa a posição cedo; largo demais,',
  '  ela devolve o lucro antes de acionar. Omitido, vale o padrão do ativo.',
  '- `ajustes_stop_loss` — OPCIONAL, em qualquer ação: lista de',
  '  `{ "id": "...", "stop_loss": 000.00, "motivo": "..." }` para ELEVAR o chão de',
  '  posições já abertas (trailing stop, protegendo lucro conforme o preço sobe) ou',
  '  para dar o primeiro chão às posições que estão com `stop_loss: null`. O chão',
  '  só pode SUBIR: pedidos de rebaixar são descartados pelo sistema. Omita o campo',
  '  quando não houver ajuste a fazer.',
  '- `confianca` — inteiro de 0 a 100.',
  '- `justificativa` — obrigatória, curta e objetiva (no máximo duas frases).',
  '  Justificativas longas correm risco de a resposta ser truncada e descartada.',
  '- Só inclua campos ADICIONAIS além dos listados acima se ALGUMA seção anterior',
  '  os pedir explicitamente; caso contrário, use apenas os campos acima.',
].join('\n');

/**
 * A camada de REENTRADA (V8.16): o Motor vendeu agora, nesta mesma rodada, e a
 * análise que vem a seguir existe por causa disso.
 *
 * Os dois motivos pedem leituras opostas, e é isso que o texto separa:
 *
 * - TRAVA DE LUCRO — a saída foi boa e a tese pode continuar de pé. Nos números
 *   de produção o preço seguiu SUBINDO depois da maioria dessas vendas, então
 *   ficar de fora por inércia custou dinheiro. Reentrar é uma opção legítima.
 * - STOP-LOSS — o chão foi furado, ou seja, a tese que abriu o lote foi
 *   INVALIDADA pelo preço. Recomprar na sequência é como se transforma um
 *   prejuízo pequeno em vários; aqui o padrão é AGUARDAR, e reentrar exige
 *   sinal novo, não a mesma tese de antes.
 *
 * O contador de 24 h é a terceira trava: mercado que serra a posição stopa de
 * novo, e duas saídas no mesmo dia dizem mais sobre o momento do que qualquer
 * indicador da rodada.
 */
function blocoSaidaAutomatica(saida) {
  const porTrava = saida.motivo === 'TRAVA_DE_LUCRO';
  const linhas = [
    '# O sistema acabou de fechar uma posição neste ativo',
    '',
    `- motivo: ${porTrava ? 'TRAVA DE LUCRO (o lote subiu e devolveu parte do topo — venda com ganho)' : 'STOP-LOSS (o preço furou o chão da posição — venda de defesa)'}`,
    `- preço da venda: ${saida.preco_da_venda}`,
    `- resultado do lote: ${saida.resultado_liquido}`,
    `- saídas automáticas deste ativo nas últimas 24 h: ${saida.saidas_automaticas_24h}`,
    '',
    'A venda JÁ ACONTECEU e não pode ser desfeita — ela não é a sua decisão. Esta',
    'análise está sendo feita agora justamente por causa dela, e a sua pergunta é',
    'outra: **vale a pena voltar a este ativo agora?**',
    '',
  ];
  if (porTrava) {
    linhas.push(
      'A saída foi por LUCRO, então a tese que abriu o lote pode continuar de pé —',
      'quem vendeu foi uma regra mecânica de realização, não uma leitura de que o',
      'movimento acabou. Se os indicadores ainda sustentam a alta, COMPRAR é uma',
      'resposta legítima aqui. Pese o custo de ida e volta: recomprar acima do preço',
      'da venda mais as duas taxas devolve parte do ganho que acabou de ser',
      'realizado, e só se justifica se o movimento à frente for maior que isso.',
    );
  } else {
    linhas.push(
      'A saída foi de DEFESA: o preço furou o chão, o que significa que a tese que',
      'abriu aquele lote foi invalidada pelo próprio mercado. O padrão aqui é',
      'AGUARDAR. Só considere COMPRAR se houver sinal NOVO de reversão nos',
      'indicadores desta rodada — repetir a tese que acabou de falhar é como um',
      'prejuízo pequeno vira uma sequência deles.',
    );
  }
  if (saida.saidas_automaticas_24h >= 2) {
    linhas.push(
      '',
      `ATENÇÃO: este ativo já teve ${saida.saidas_automaticas_24h} saídas automáticas nas últimas 24 h. Isso é o`,
      'retrato de um preço serrando de um lado para o outro, e o custo dessas idas e',
      'voltas se acumula. Nesta condição, AGUARDAR é quase sempre a decisão certa.',
    );
  }
  return linhas.join('\n');
}

/**
 * Monta o prompt de sistema.
 *
 * Validade do contexto (V6.2): a IA define UMA vez, na primeira análise após o
 * contexto ser (re)escrito, por quantos dias ele ainda vale. Enquanto não há
 * validade, o contexto entra no prompt COM um pedido para a IA devolvê-la
 * (`pedeValidadeContexto: true`). Depois de definida, o contexto entra normal
 * (sem novo pedido); passada a data, ele nem é enviado.
 *
 * @param {object} p
 *   manifest     — manifest do ativo ({ id, nome, tipo, par, mercado24h, usa* })
 *   regrasGerais — doc GLOBAL de regras gerais ({ conteudo }) ou null
 *   template     — doc do template da plataforma ({ conteudo }) ou null
 *   promptAtivo  — doc do prompt do ativo ({ conteudo }) ou null
 *   supervisao   — doc da camada de supervisão ({ conteudo, versao }) ou null (V7.2)
 *   contexto     — doc do contexto ({ texto, atualizado_em, validade_ate }) ou null
 *   saidaAutomatica — a venda que o MOTOR acabou de executar nesta rodada
 *                  ({ motivo, preco_da_venda, resultado_liquido, ... }) ou null (V8.16)
 *   agora        — Date de referência para a validade (padrão: agora)
 * @returns {{ texto: string, partes: string[], pedeValidadeContexto: boolean }}
 */
export function montarPromptSistema({ manifest, plataforma = null, regrasGerais = null, regrasGeraisVenda = null, template = null, promptAtivo = null, supervisao = null, noticias = null, contexto = null, modoVendas = null, saidaAutomatica = null, agora = new Date() }) {
  const partes = [];
  const liquidando = modoVendas?.ativo === true;
  // Plataforma cujo mercado é de outra natureza (`usaRegrasGerais: false` —
  // hoje as skins da Steam) NÃO recebe as regras gerais: elas falam de RSI,
  // MACD, candles de 15 minutos e taxa de 0,1%, e nada disso existe lá. No
  // lugar delas vale o template da plataforma, escrito pelo dono.
  // Isto NÃO afrouxa proteção nenhuma: "nunca vender no prejuízo", stop-loss,
  // folga do chão e orçamento vivem no Motor de Regras, em código — o prompt
  // nunca foi o que segurava isso. O que muda é só o texto que a IA lê.
  // A LIQUIDAÇÃO (V8) ignora este flag de propósito: ela é uma ordem do dono
  // para a carteira inteira, e vale em toda plataforma.
  const semRegrasGerais = plataforma?.usaRegrasGerais === false && !liquidando;

  // Regras gerais SEMPRE primeiro: têm prioridade sobre todas as outras camadas.
  // No MODO VENDAS (V8) elas são SUBSTITUÍDAS pelas regras de liquidação — não
  // somadas. Empilhar as duas entregaria à IA um prompt que manda comprar na
  // correção e liquidar tudo ao mesmo tempo; prompt contraditório não é
  // conservadorismo, é decisão pior.
  if (!semRegrasGerais) {
    partes.push(
      liquidando
        ? (regrasGeraisVenda?.conteudo?.trim() || regrasGeraisVendaSemente().trim())
        : (regrasGerais?.conteudo?.trim() || regrasGeraisSemente().trim()),
    );
  }

  // O prazo e a tolerância de HOJE, em texto, logo depois das regras: o JSON do
  // cenário também os leva, mas quem lê a §2 das regras de liquidação precisa
  // do número na mesma altura da instrução que o usa.
  if (liquidando) {
    partes.push(
      [
        '# Liquidação em curso',
        '',
        `- dia: ${modoVendas.dia} de ${modoVendas.dias_totais}`,
        `- prejuízo máximo aceito HOJE por posição: ${modoVendas.perda_maxima_percentual}% do custo do lote`,
        '',
        'O dono da conta ligou o modo vendas. Sua tarefa é encerrar as posições abertas',
        'com o melhor resultado possível dentro do prazo. COMPRAR está bloqueado pelo',
        'sistema e será rejeitado.',
      ].join('\n'),
    );
  }

  if (manifest.usaTemplatePlataforma !== false) {
    const conteudo = template?.conteudo?.trim();
    // A semente (`promptBase.md`) é o prompt genérico de ativo financeiro: fala
    // de RSI, MACD e candles. Numa plataforma que dispensou as regras gerais
    // justamente por não ter nada disso, cair nela seria pior que ficar sem
    // texto — a IA receberia instruções sobre dados que não vão chegar.
    if (conteudo) partes.push(conteudo);
    else if (!semRegrasGerais) partes.push(templateSemente().trim());
  }

  partes.push(
    [
      '# Ativo em análise',
      '',
      `- id: ${manifest.id}`,
      `- nome: ${manifest.nome || manifest.id}`,
      `- tipo: ${manifest.tipo}`,
      `- par negociado: ${manifest.par}`,
      `- mercado 24h: ${manifest.mercado24h === false ? 'não (horário de pregão)' : 'sim'}`,
    ].join('\n'),
  );

  if (manifest.usaPromptPersonalizado !== false && promptAtivo?.conteudo?.trim()) {
    partes.push(`# Instruções específicas deste ativo\n\n${promptAtivo.conteudo.trim()}`);
  }

  // Supervisão semanal (V7.2) — escrita por OUTRA IA, que auditou o desempenho
  // das últimas semanas. Entra DEPOIS das regras gerais e do prompt do ativo,
  // e o cabeçalho fixo abaixo (não editável pelo supervisor) declara a
  // subordinação: se o texto dele conflitar com as regras gerais, valem as
  // regras. Recortada por ativo — a nota de um ativo nunca vaza para outro.
  // No MODO VENDAS a camada do supervisor SAI do prompt: ela foi escrita
  // auditando decisões de ENTRADA (quando comprar, que chão usar, que tamanho),
  // e nada nela se aplica a uma liquidação. Manter seria ruído no melhor caso e
  // instrução contraditória no pior. O doc continua guardado — desligar o modo
  // devolve a camada intacta.
  if (manifest.usaSupervisao !== false && !liquidando) {
    const recorte = recortarSupervisao(supervisao?.conteudo, manifest.plataforma, manifest.id);
    if (recorte) {
      const versao = supervisao?.versao ? ` v${supervisao.versao}` : '';
      const data = supervisao?.atualizado_em ? ` · ${supervisao.atualizado_em.slice(0, 10)}` : '';
      partes.push(
        `# Ajustes da supervisão semanal${versao}${data}\n\n` +
          'As observações abaixo vêm da revisão do seu próprio desempenho nas últimas semanas. ' +
          'Elas CALIBRAM o seu julgamento em pontos onde ele falhou; elas não revogam nada. ' +
          'Em qualquer conflito com as regras gerais ou com o formato de saída, as regras gerais e o formato prevalecem.\n\n' +
          recorte,
      );
    }
  }

  // Atualizações do JOGO (fase 2/3 da Steam). Entra DEPOIS do prompt do ativo e
  // ANTES do contexto do dono, na mesma lógica das outras camadas: fato do
  // mundo primeiro, opinião do dono por último.
  //
  // Num mercado de skin isto não é enfeite — é o fundamento: case nova,
  // operação e mudança de drop movem o preço mais que qualquer outra coisa. A
  // IA continua sem acessar rede: o texto foi buscado pelo bot (conector) e
  // chega aqui pronto, como todo o resto.
  if (manifest.usaNoticias !== false) {
    const itens = (Array.isArray(noticias?.itens) ? noticias.itens : []).slice(0, 3);
    if (itens.length > 0) {
      const blocos = itens.map((n) => {
        const data = n.data ? n.data.slice(0, 10) : 'data desconhecida';
        return `## ${n.titulo} (${data})\n\n${String(n.conteudo ?? '').trim()}`;
      });
      partes.push(
        '# Atualizações recentes do jogo\n\n' +
          'Notas oficiais publicadas pela desenvolvedora, da mais recente para a mais antiga. ' +
          'Pese a DATA: o efeito de um anúncio no preço costuma acontecer nos primeiros dias e ' +
          'depois se dissolve. Nem toda atualização mexe no preço de um item — correção de bug ' +
          'de mapa não move nada; item novo, mudança no que se pode obter e evento com premiação ' +
          'movem.\n\n' +
          blocos.join('\n\n'),
      );
    }
  }

  // Contexto do usuário — considerando a validade (V6.2): contexto EXPIRADO não
  // entra; contexto SEM validade entra e pede que a IA a defina.
  let pedeValidadeContexto = false;
  const temContexto = manifest.usaContexto !== false && contexto?.texto?.trim();
  const expirado = contexto?.validade_ate && new Date(contexto.validade_ate).getTime() <= agora.getTime();
  if (temContexto && !expirado) {
    const data = contexto.atualizado_em ? contexto.atualizado_em.slice(0, 10) : 'data desconhecida';
    let bloco =
      `# Contexto fornecido pelo dono da conta (escrito em ${data})\n\n` +
      `${contexto.texto.trim()}\n\n` +
      'Considere este contexto na decisão, ponderando a data em que foi escrito: ' +
      'quanto mais antigo, menor o peso que ele deve ter.';
    if (!contexto.validade_ate) {
      pedeValidadeContexto = true;
      bloco +=
        '\n\nVALIDADE DESTE CONTEXTO: ele ainda não tem prazo definido. NESTA resposta ' +
        '(e somente nesta), inclua no JSON o campo adicional `validade_contexto_dias` ' +
        '(inteiro > 0): por quantos dias, a partir de hoje, este contexto deve continuar ' +
        'influenciando as decisões. Notícia de curtíssimo prazo → poucos dias; fato ' +
        'estrutural/tese de longo prazo → dezenas ou centenas de dias. Passado o prazo, ' +
        'ele deixa de ser enviado. O prazo é definido só desta vez e não será mais perguntado.';
    }
    partes.push(bloco);
  }

  // REENTRADA APÓS A VENDA DO MOTOR (V8.16). Última camada de conteúdo, logo
  // antes do contrato de formato, porque é o fato mais recente do ciclo e o
  // motivo de esta análise existir: o lote foi fechado há segundos e a pergunta
  // mudou de "vender?" para "voltar?".
  //
  // O texto é do CÓDIGO, não editável pela dashboard, pelo mesmo motivo do
  // bloco da liquidação: o número que ele carrega é medido pelo bot, e um
  // template reescrito não pode fazer a IA achar que ainda tem posição aberta.
  if (saidaAutomatica) {
    partes.push(blocoSaidaAutomatica(saidaAutomatica));
  }

  // Contrato de saída SEMPRE por último: é a palavra final sobre o FORMATO,
  // imune a edições de template/regras (ver CONTRATO_SAIDA acima).
  partes.push(CONTRATO_SAIDA);

  return { texto: partes.join(SEPARADOR), partes, pedeValidadeContexto };
}
