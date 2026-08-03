// limiteLogin.js — freio de tentativas de login do painel.
//
// O QUE ISTO É E O QUE NÃO É. Este módulo roda no navegador, então ele NÃO
// protege contra força bruta: a `apiKey` do Firebase é pública e quem quiser
// atacar chama o endpoint do Identity Toolkit direto, sem passar por aqui. Quem
// barra ataque de verdade é o servidor — o Firebase Auth já limita tentativas
// por IP (`auth/too-many-requests`), e o degrau seguinte é o App Check.
//
// O que ele resolve, e é real: o bloqueio do Google é por IP e não distingue
// atacante de dono distraído. Sem freio local, errar a senha algumas vezes
// seguidas tranca o DONO fora do painel por um tempo que ele não controla nem
// enxerga. O freio local segura antes disso, com contagem regressiva na tela.
//
// Módulo PURO: sem DOM, sem storage, sem relógio próprio (o `agora` vem de
// fora). Quem faz a ponte com o localStorage é o app.js.

/** Tentativas erradas permitidas antes do primeiro bloqueio. */
export const TENTATIVAS_LIVRES = 3;
/** Espera do 1º bloqueio, em segundos (dobra a cada nova falha). */
export const ESPERA_INICIAL_S = 15;
/** Teto da espera. Acima disto o freio vira punição ao dono, não proteção. */
export const ESPERA_MAXIMA_S = 300;
/** Sem erro por este tempo, o contador zera — erro de ontem não pune hoje. */
export const JANELA_ESQUECIMENTO_MS = 30 * 60 * 1000;

/** Estado limpo (nenhuma falha registrada). */
export const ESTADO_ZERADO = { falhas: 0, bloqueado_ate: null, ultima_falha: null };

/**
 * Quantos segundos esperar depois de `falhas` erros seguidos.
 * As TENTATIVAS_LIVRES primeiras não bloqueiam; da seguinte em diante a espera
 * dobra (15s, 30s, 60s…) até o teto.
 */
export function esperaSegundos(falhas) {
  // `excedentes` conta as falhas ALÉM das livres: a de número TENTATIVAS_LIVRES
  // ainda é livre (excedentes = 0), e a seguinte é a primeira a bloquear.
  const excedentes = Math.floor(falhas) - TENTATIVAS_LIVRES;
  if (excedentes <= 0) return 0;
  return Math.min(ESPERA_INICIAL_S * 2 ** (excedentes - 1), ESPERA_MAXIMA_S);
}

/**
 * Normaliza o que veio do storage. Dado corrompido (usuário editou, versão
 * antiga, JSON quebrado) nunca pode trancar o dono: na dúvida, estado zerado.
 */
export function normalizar(bruto) {
  if (typeof bruto !== 'object' || bruto === null) return { ...ESTADO_ZERADO };
  const falhas = Number(bruto.falhas);
  return {
    falhas: Number.isFinite(falhas) && falhas > 0 ? Math.floor(falhas) : 0,
    bloqueado_ate: Number.isFinite(Number(bruto.bloqueado_ate)) ? Number(bruto.bloqueado_ate) : null,
    ultima_falha: Number.isFinite(Number(bruto.ultima_falha)) ? Number(bruto.ultima_falha) : null,
  };
}

/**
 * O login está liberado agora?
 *
 * @returns {{ bloqueado: boolean, faltam_s: number, estado: object }}
 *          `estado` já vem com o esquecimento aplicado — quem chama persiste.
 */
export function estadoLimite(bruto, agora = Date.now()) {
  let estado = normalizar(bruto);

  // Passou a janela sem errar de novo? O contador zera. Sem isto, uma senha
  // errada há três semanas ainda cobraria espera na próxima digitação.
  const expirou = estado.ultima_falha !== null && agora - estado.ultima_falha > JANELA_ESQUECIMENTO_MS;
  if (expirou && (estado.bloqueado_ate === null || agora >= estado.bloqueado_ate)) {
    estado = { ...ESTADO_ZERADO };
  }

  const restante = estado.bloqueado_ate === null ? 0 : estado.bloqueado_ate - agora;
  return {
    bloqueado: restante > 0,
    faltam_s: restante > 0 ? Math.ceil(restante / 1000) : 0,
    estado,
  };
}

/** Registra uma tentativa errada e devolve o estado NOVO (para persistir). */
export function registrarFalha(bruto, agora = Date.now()) {
  const { estado } = estadoLimite(bruto, agora);
  const falhas = estado.falhas + 1;
  const espera = esperaSegundos(falhas);
  return {
    falhas,
    ultima_falha: agora,
    bloqueado_ate: espera > 0 ? agora + espera * 1000 : null,
  };
}

/**
 * Mensagem para o dono. Erro de credencial NUNCA revela se o e-mail existe
 * (enumeração de conta): senha errada e conta inexistente dizem a mesma coisa.
 */
export function mensagemErro(codigo) {
  switch (codigo) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos.';
    case 'auth/invalid-email':
      return 'E-mail em formato inválido.';
    case 'auth/user-disabled':
      return 'Esta conta está desativada.';
    case 'auth/too-many-requests':
      // Bloqueio do SERVIDOR (por IP), não deste freio: some sozinho depois de
      // um tempo que o Firebase não informa. Dizer isso evita o dono achar que
      // perdeu a conta e sair trocando senha no susto.
      return 'O Firebase bloqueou temporariamente as tentativas deste dispositivo '
        + 'por excesso de erros. Espere alguns minutos e tente de novo — ou entre '
        + 'pelo app do Firebase para redefinir a senha.';
    case 'auth/network-request-failed':
      return 'Sem conexão com o Firebase. Verifique a internet e tente de novo.';
    default:
      return `Falha no login (${codigo ?? 'erro desconhecido'}).`;
  }
}
