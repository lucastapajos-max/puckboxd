// Times da NHL na temporada 2025-26. Usado para validar parâmetros e pelo mock.
export const TEAMS = {
  ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montréal Canadiens', NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken',
  STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
};

export const isTeam = (abbrev) => Object.hasOwn(TEAMS, abbrev);

// Formas de chamar cada time na busca: sigla, cidade, nome, nome completo e apelidos da torcida.
// Tudo em minúsculas, sem acento. "New York" fica de fora de propósito (são dois times).
const CITY_NAME = {
  ANA: ['anaheim', 'ducks'], BOS: ['boston', 'bruins'], BUF: ['buffalo', 'sabres'], CGY: ['calgary', 'flames'],
  CAR: ['carolina', 'hurricanes'], CHI: ['chicago', 'blackhawks'], COL: ['colorado', 'avalanche'], CBJ: ['columbus', 'blue jackets'],
  DAL: ['dallas', 'stars'], DET: ['detroit', 'red wings'], EDM: ['edmonton', 'oilers'], FLA: ['florida', 'panthers'],
  LAK: ['los angeles', 'kings'], MIN: ['minnesota', 'wild'], MTL: ['montreal', 'canadiens'], NSH: ['nashville', 'predators'],
  NJD: ['new jersey', 'devils'], NYI: [null, 'islanders'], NYR: [null, 'rangers'], OTT: ['ottawa', 'senators'],
  PHI: ['philadelphia', 'flyers'], PIT: ['pittsburgh', 'penguins'], SJS: ['san jose', 'sharks'], SEA: ['seattle', 'kraken'],
  STL: ['st louis', 'blues'], TBL: ['tampa bay', 'lightning'], TOR: ['toronto', 'maple leafs'], UTA: ['utah', 'mammoth'],
  VAN: ['vancouver', 'canucks'], VGK: ['vegas', 'golden knights'], WSH: ['washington', 'capitals'], WPG: ['winnipeg', 'jets'],
};
const SLANG = {
  ANA: ['anaheim ducks'], BOS: ['bs'], CAR: ['canes'], CHI: ['hawks'], COL: ['avs'], CBJ: ['jackets', 'cbj'],
  DET: ['wings'], EDM: ['oil'], FLA: ['cats'], LAK: ['la', 'la kings'], MTL: ['habs'], NSH: ['preds'],
  NJD: ['nj'], NYI: ['isles', 'ny islanders'], NYR: ['blueshirts', 'ny rangers'], OTT: ['sens'], PIT: ['pens'],
  SJS: ['sj'], STL: ['saint louis', 'st. louis'], TBL: ['bolts', 'tampa', 'tb'], TOR: ['leafs'], VAN: ['nucks'],
  VGK: ['knights', 'las vegas', 'vgk'], WSH: ['caps'], WPG: ['winnipeg jets'],
};

export const normalizeText = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Pares [apelido normalizado, sigla], do mais longo para o mais curto (casa "red wings" antes de "wings").
export const TEAM_ALIASES = Object.entries(TEAMS)
  .flatMap(([abbrev, full]) => {
    const [city, name] = CITY_NAME[abbrev];
    return [abbrev, full, city, name, ...(SLANG[abbrev] ?? [])].filter(Boolean).map((a) => [normalizeText(a), abbrev]);
  })
  .sort((a, b) => b[0].length - a[0].length);

// Times citados num texto, na ordem em que aparecem ("caps vs pens" → ['WSH', 'PIT']).
export function findTeams(text) {
  let padded = ` ${normalizeText(text)} `;
  const found = [];
  for (const [alias, abbrev] of TEAM_ALIASES) {
    let i;
    while ((i = padded.indexOf(` ${alias} `)) !== -1) {
      found.push([i, abbrev]);
      // apaga o trecho para "devils" não casar de novo dentro de "new jersey devils"
      padded = padded.slice(0, i + 1) + '#'.repeat(alias.length) + padded.slice(i + 1 + alias.length);
    }
  }
  return [...new Set(found.sort((a, b) => a[0] - b[0]).map(([, abbrev]) => abbrev))];
}
