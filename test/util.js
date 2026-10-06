// Instante no horário de Brasília. 05/10/2026 é segunda-feira.
export const sp = (s) => Date.parse(s.replace(' ', 'T') + ':00-03:00');
