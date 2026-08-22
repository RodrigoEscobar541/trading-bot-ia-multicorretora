// conexaoStatus.js — como a dashboard descreve a conexão com uma corretora.
//
// Módulo PURO (sem DOM, sem Firebase), pelo mesmo motivo de limiteLogin.js,
// orcamentos.js e patrimonio.js: é uma conta que decide algo VISÍVEL, e conta
// solta dentro do app.js já errou em silêncio antes (CLAUDE.md §12).
//
// O ponto da V8.21 (§10.11): até aqui existiam DOIS estados — autenticada ou
// não —, e o ✅ vinha de uma chamada de LEITURA. Em 13/08 a chave da Binance
// lia e não negociava, e a tela disse "conectado" por dias enquanto a única
// ordem real voltava erro. Agora são QUATRO, e o que muda a vida do dono é o
// terceiro: LÊ MAS NÃO OPERA.

/**
 * @param {object|null} conexao  o `dados/estado.conexao` da plataforma
 * @returns {{ nivel: string, icone: string, titulo: string, detalhe: string, classe: string }}
 *   nivel ∈ 'sem_dado' | 'fora_do_ar' | 'nao_opera' | 'nao_verificado' | 'opera'
 *   classe: '' | 'texto-erro' | 'texto-alerta' (a folha de estilo cuida da cor)
 */
export function estadoConexao(conexao) {
  if (!conexao) {
    return { nivel: 'sem_dado', icone: '', titulo: 'ainda não verificada', detalhe: '', classe: '' };
  }
  if (!conexao.ok) {
    return {
      nivel: 'fora_do_ar',
      icone: '❌',
      titulo: 'fora do ar',
      detalhe: conexao.erro ?? 'erro desconhecido',
      classe: 'texto-erro',
    };
  }
  // `false` é uma prova; `null`/ausente é falta de prova. Só o primeiro alarma.
  if (conexao.pode_executar === false) {
    return {
      nivel: 'nao_opera',
      icone: '⚠️',
      titulo: 'lê mas NÃO envia ordens',
      detalhe: conexao.erro_execucao ?? 'a corretora recusou o pedido de teste',
      classe: 'texto-alerta',
    };
  }
  if (conexao.pode_executar === true) {
    return { nivel: 'opera', icone: '✅', titulo: 'autenticada e apta a operar', detalhe: '', classe: '' };
  }
  // Autenticada, sem prova de execução: ou a plataforma não tem como provar
  // (o MB não tem endpoint de teste; as assistidas não executam), ou a
  // tentativa foi inconclusiva — e aí o motivo aparece, sem virar alarme.
  return {
    nivel: 'nao_verificado',
    icone: '✅',
    titulo: 'autenticada',
    detalhe: conexao.erro_execucao ? `envio de ordens não verificado: ${conexao.erro_execucao}` : '',
    classe: '',
  };
}

/** Uma linha curta, para a tabela da visão geral. */
export function resumoConexao(conexao, dataHora = (v) => v ?? '') {
  const e = estadoConexao(conexao);
  if (e.nivel === 'sem_dado') return e.titulo;
  if (e.nivel === 'opera' || e.nivel === 'nao_verificado') {
    return `${e.icone} ${e.titulo} · ${dataHora(conexao.verificado_em)}`;
  }
  return `${e.icone} ${e.titulo}${e.detalhe ? ` — ${e.detalhe}` : ''}`;
}
