import type { AppLanguage } from '../../locale.js'

export type TShoppingListLanguage = AppLanguage

const SWEDISH_INGREDIENT_LABELS: Record<string, string> = {
  avocado: 'avokado',
  'bacon or pancetta': 'bacon eller pancetta',
  'basil pesto': 'basilikapesto',
  'basmati rice': 'basmatiris',
  'beef mince': 'nötfärs',
  'beef stew meat': 'grytbitar av nöt',
  'beef stock': 'köttbuljong',
  'beef strips': 'strimlat nötkött',
  'bell peppers': 'paprika',
  'black beans': 'svarta bönor',
  broccoli: 'broccoli',
  butter: 'smör',
  cabbage: 'kål',
  carrot: 'morot',
  carrots: 'morötter',
  'cherry tomatoes': 'körsbärstomater',
  'chicken breast': 'kycklingfilé',
  'chicken stock': 'kycklingbuljong',
  chickpeas: 'kikärtor',
  'coconut milk': 'kokosmjölk',
  'cooked rice': 'kokt ris',
  'cooking cream': 'matlagningsgrädde',
  corn: 'majs',
  'crushed tomatoes': 'krossade tomater',
  cucumber: 'gurka',
  'curry paste': 'currypasta',
  egg: 'ägg',
  eggs: 'ägg',
  feta: 'fetaost',
  flour: 'mjöl',
  'flour tortillas': 'tortillabröd',
  'frozen vegetables': 'frysta grönsaker',
  garlic: 'vitlök',
  'grated cheese': 'riven ost',
  'green beans': 'gröna bönor',
  'green curry paste': 'grön currypasta',
  ham: 'skinka',
  honey: 'honung',
  leek: 'purjolök',
  leeks: 'purjolök',
  lemon: 'citron',
  lime: 'lime',
  mayonnaise: 'majonnäs',
  milk: 'mjölk',
  mushrooms: 'svamp',
  'olive oil': 'olivolja',
  onion: 'lök',
  parmesan: 'parmesan',
  pasta: 'pasta',
  peas: 'ärtor',
  potatoes: 'potatis',
  'red lentils': 'röda linser',
  rice: 'ris',
  'rice noodles': 'risnudlar',
  'rice vinegar': 'risvinäger',
  'risotto rice': 'risottoris',
  salsa: 'salsa',
  'sesame oil': 'sesamolja',
  'sesame seeds': 'sesamfrön',
  shrimp: 'räkor',
  'soy sauce': 'soja',
  spaghetti: 'spaghetti',
  spinach: 'spenat',
  'sweet potato': 'sötpotatis',
  tomato: 'tomat',
  tomatoes: 'tomater',
  tofu: 'tofu',
  'vegetable oil': 'vegetabilisk olja',
  'vegetable stock': 'grönsaksbuljong',
  zucchini: 'zucchini',
}

const SWEDISH_UNIT_LABELS: Record<string, string> = {
  can: 'burk',
  cloves: 'klyftor',
  pc: 'st',
  tbsp: 'msk',
  tsp: 'tsk',
}

export function localizeShoppingIngredientLabel(label: string, language: TShoppingListLanguage) {
  if (language !== 'sv') return label
  return SWEDISH_INGREDIENT_LABELS[label.trim().toLowerCase()] ?? label
}

export function localizeShoppingUnit(unit: string | null, language: TShoppingListLanguage) {
  if (!unit || language !== 'sv') return unit
  return SWEDISH_UNIT_LABELS[unit.trim().toLowerCase()] ?? unit
}
