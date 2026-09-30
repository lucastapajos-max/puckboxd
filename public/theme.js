// Aplica o tema antes de a página aparecer (evita piscar no tema errado).
// Sem escolha salva, segue o tema do sistema.
(() => {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* sem storage */ }
  const theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
})();
