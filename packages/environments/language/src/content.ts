/**
 * The shipped course: Spanish basics for English speakers — greetings,
 * articles and gender, ser, estar, choosing between them, and simple
 * sentences. Hand-written; every item is checked by the kinds' validators.
 * @module @hodos/language/content
 */
import type { ContentPack, CourseSpec, ExerciseItem, ExerciseMode, ItemHint, JsonObject, LessonSpec, SkillSpec } from '@hodos/plugin-sdk'
import { MISCONCEPTIONS } from './grader.js'
import { BLANK, ENVIRONMENT, KIND } from './kinds.js'

/** Skill ids of the course. */
export const SKILL = {
  greetings: 'es.greetings',
  articles: 'es.articles',
  ser: 'es.ser',
  estar: 'es.estar',
  serEstar: 'es.ser-estar',
  sentences: 'es.sentences',
} as const

const P: readonly ExerciseMode[] = ['practice', 'review']
const C: readonly ExerciseMode[] = ['checkpoint']
const D: readonly ExerciseMode[] = ['diagnostic']

/** Misconceptions of choosing between ser and estar. */
const SER_ESTAR_FEEDBACK: Readonly<Record<string, string>> = {
  'ser-for-location': 'Where someone or something is (location) uses estar, not ser.',
  'ser-for-condition': 'A temporary state (tired, cold, busy) uses estar, not ser.',
  'estar-for-identity': 'Who or what someone is (profession, origin, character) uses ser, not estar.',
}

interface Spec {
  readonly id: string
  readonly kind: string
  readonly skill: string
  readonly modes: readonly ExerciseMode[]
  readonly difficulty: number
  readonly payload: JsonObject
  readonly key: JsonObject
  /** Level-1 hint: the rule to apply. */
  readonly rule: string
  readonly explanation: string
  /** Feedback per misconception the grader can report for this item. */
  readonly feedback?: Readonly<Record<string, string>>
}

function hints(spec: Spec): ItemHint[] {
  const accepted = spec.key.accepted
  const first = Array.isArray(accepted) && typeof accepted[0] === 'string' ? accepted[0] : ''
  if (spec.kind === KIND.choice) {
    const correct = typeof spec.key.correct === 'string' ? spec.key.correct : ''
    return [{ level: 1, text: spec.rule }, { level: 5, text: `The answer is option (${correct}).` }]
  }
  return [
    { level: 1, text: spec.rule },
    { level: 2, text: `It starts with "${first.replace(/^[¿¡]/u, '').charAt(0)}".` },
    { level: 5, text: `The answer is "${first}".` },
  ]
}

function item(spec: Spec): ExerciseItem {
  return {
    id: spec.id,
    kind: spec.kind,
    skills: [{ skillId: spec.skill, weight: 1 }],
    difficulty: spec.difficulty,
    modes: [...spec.modes],
    payload: spec.payload,
    key: spec.key,
    hints: hints(spec),
    explanation: spec.explanation,
    ...(spec.feedback === undefined ? {} : { misconceptionFeedback: { ...spec.feedback } }),
    provenance: { source: 'authored' },
  }
}

const recall = (id: string, skill: string, modes: readonly ExerciseMode[], prompt: string, accepted: string[], rule: string, explanation: string, difficulty = 0, note?: string): ExerciseItem =>
  item({ id, kind: KIND.recall, skill, modes, difficulty, payload: { prompt, from: 'en', to: 'es', ...(note === undefined ? {} : { note }) }, key: { accepted }, rule, explanation, feedback: MISCONCEPTIONS })

const cloze = (id: string, skill: string, modes: readonly ExerciseMode[], sentence: string, translation: string, accepted: string[], rule: string, explanation: string, difficulty = 0): ExerciseItem =>
  item({ id, kind: KIND.cloze, skill, modes, difficulty, payload: { sentence, translation }, key: { accepted }, rule, explanation, feedback: MISCONCEPTIONS })

const choice = (id: string, skill: string, modes: readonly ExerciseMode[], prompt: string, options: string[], correct: number, rule: string, explanation: string, misconceptions: Record<number, string> = {}, difficulty = 0): ExerciseItem => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const mapped = Object.fromEntries(Object.entries(misconceptions).map(([index, m]) => [ids[Number(index)] ?? 'a', m]))
  return item({
    id, kind: KIND.choice, skill, modes, difficulty,
    payload: { prompt, options: options.map((text, i) => ({ id: ids[i] ?? String(i), text })) },
    key: { correct: ids[correct] ?? 'a', ...(Object.keys(mapped).length === 0 ? {} : { misconceptions: mapped }) },
    rule, explanation,
    ...(Object.keys(mapped).length === 0 ? {} : { feedback: SER_ESTAR_FEEDBACK }),
  })
}

const conjugate = (id: string, skill: string, modes: readonly ExerciseMode[], verb: string, person: string, accepted: string[], rule: string, explanation: string, difficulty = 0): ExerciseItem =>
  item({ id, kind: KIND.conjugate, skill, modes, difficulty, payload: { verb, person, tense: 'present', meaning: 'to be' }, key: { accepted }, rule, explanation, feedback: MISCONCEPTIONS })

const order = (id: string, skill: string, modes: readonly ExerciseMode[], tokens: string[], translation: string, accepted: string[], rule: string, explanation: string, difficulty = 0): ExerciseItem =>
  item({ id, kind: KIND.order, skill, modes, difficulty, payload: { tokens, translation }, key: { accepted }, rule, explanation, feedback: MISCONCEPTIONS })

const translate = (id: string, skill: string, modes: readonly ExerciseMode[], text: string, accepted: string[], rule: string, explanation: string, difficulty = 0): ExerciseItem =>
  item({ id, kind: KIND.translate, skill, modes, difficulty, payload: { text, from: 'en', to: 'es' }, key: { accepted }, rule, explanation, feedback: MISCONCEPTIONS })

const GREET = 'Think of the everyday phrase from the greetings lesson.'
const ART = 'Nouns ending in -o are usually masculine (el, un) and in -a feminine (la, una); learn the exceptions.'
const SER = 'Ser is irregular: soy, eres, es, somos, sois, son.'
const ESTAR = 'Estar: estoy, estás, está, estamos, estáis, están — note the accents.'
const SER_ESTAR = 'Ser for who or what someone is (identity, profession, origin, character); estar for where and how (location, temporary state).'
const ORDER = 'Spanish word order is usually subject, verb, then the rest; the subject pronoun may be left out.'

const ITEMS: readonly ExerciseItem[] = [
  // Greetings and courtesy.
  recall('g-hello', SKILL.greetings, P, 'hello', ['hola'], GREET, '"Hola" is the everyday greeting at any time of day.', -1.5),
  recall('g-thanks', SKILL.greetings, P, 'thank you', ['gracias'], GREET, '"Gracias" means thank you; "muchas gracias" is thank you very much.', -1.2),
  recall('g-please', SKILL.greetings, P, 'please', ['por favor'], GREET, '"Por favor" means please.', -1),
  recall('g-goodbye', SKILL.greetings, P, 'goodbye', ['adiós', 'chao', 'chau'], GREET, '"Adiós" means goodbye; "chao" is a casual alternative.', -1),
  recall('g-good-morning', SKILL.greetings, P, 'good morning', ['buenos días'], GREET, '"Buenos días" is used until about noon. Note the plural: buenos días.', -0.5),
  choice('g-welcome', SKILL.greetings, P, 'Someone says "gracias". What do you answer?', ['De nada', 'Por favor', 'Hola', 'Buenas noches'], 0, GREET, '"De nada" (you\'re welcome) is the usual answer to "gracias".'),
  recall('g-c-good-night', SKILL.greetings, C, 'good night', ['buenas noches'], GREET, '"Buenas noches" means good evening and good night.', 0),
  recall('g-c-good-afternoon', SKILL.greetings, C, 'good afternoon', ['buenas tardes'], GREET, '"Buenas tardes" is used from about noon until dark.', 0),
  recall('g-c-see-you', SKILL.greetings, C, 'see you later', ['hasta luego'], GREET, '"Hasta luego" means see you later.', 0.3),
  recall('g-c-how-are-you', SKILL.greetings, C, 'How are you?', ['¿Cómo estás?', '¿Qué tal?'], GREET, '"¿Cómo estás?" and "¿Qué tal?" are the informal ways to ask how someone is.', 0.5, 'informal'),
  recall('g-d-yes', SKILL.greetings, D, 'yes', ['sí'], GREET, '"Sí" (with an accent) means yes; "si" without it means if.', -1),
  recall('g-d-welcome', SKILL.greetings, D, 'you\'re welcome', ['de nada'], GREET, '"De nada" means you\'re welcome.', -0.5),

  // Articles and gender.
  choice('a-libro', SKILL.articles, P, `${BLANK} libro (the book)`, ['el', 'la', 'los', 'las'], 0, ART, '"Libro" is masculine and singular: el libro.', {}, -1),
  choice('a-casa', SKILL.articles, P, `${BLANK} casa (the house)`, ['el', 'la', 'los', 'las'], 1, ART, '"Casa" is feminine and singular: la casa.', {}, -1),
  choice('a-perros', SKILL.articles, P, `${BLANK} perros (the dogs)`, ['el', 'la', 'los', 'las'], 2, ART, '"Perros" is masculine plural: los perros.', {}, -0.5),
  choice('a-mesas', SKILL.articles, P, `${BLANK} mesas (the tables)`, ['el', 'la', 'los', 'las'], 3, ART, '"Mesas" is feminine plural: las mesas.', {}, -0.5),
  cloze('a-un-gato', SKILL.articles, P, `Tengo ${BLANK} gato.`, 'I have a cat.', ['un'], ART, '"Gato" is masculine, so "a cat" is un gato.', 0),
  cloze('a-una-ciudad', SKILL.articles, P, `Es ${BLANK} ciudad bonita.`, 'It is a pretty city.', ['una'], ART, '"Ciudad" is feminine, so "a city" is una ciudad.', 0.3),
  choice('a-c-mano', SKILL.articles, C, `${BLANK} mano (the hand)`, ['el', 'la', 'los', 'las'], 1, ART, '"Mano" ends in -o but is feminine: la mano.', {}, 1),
  choice('a-c-dia', SKILL.articles, C, `${BLANK} día (the day)`, ['el', 'la', 'los', 'las'], 0, ART, '"Día" ends in -a but is masculine: el día.', {}, 1),
  choice('a-c-chicas', SKILL.articles, C, `${BLANK} chicas (the girls)`, ['el', 'la', 'los', 'las'], 3, ART, '"Chicas" is feminine plural: las chicas.', {}, 0),
  cloze('a-c-lapiz', SKILL.articles, C, `Necesito ${BLANK} lápiz.`, 'I need a pencil.', ['un'], ART, '"Lápiz" is masculine: un lápiz.', 0.5),
  choice('a-d-nina', SKILL.articles, D, `${BLANK} niña (the girl)`, ['el', 'la', 'los', 'las'], 1, ART, '"Niña" is feminine: la niña.', {}, -0.5),
  choice('a-d-coche', SKILL.articles, D, `${BLANK} coche (the car)`, ['el', 'la', 'los', 'las'], 0, ART, '"Coche" is masculine: el coche.', {}, 0),

  // Ser.
  conjugate('s-yo', SKILL.ser, P, 'ser', 'yo', ['soy'], SER, 'yo soy — I am.', -0.5),
  conjugate('s-tu', SKILL.ser, P, 'ser', 'tú', ['eres'], SER, 'tú eres — you are (informal).', 0),
  conjugate('s-el', SKILL.ser, P, 'ser', 'él / ella / usted', ['es'], SER, 'él, ella and usted take es.', -0.5),
  cloze('s-somos', SKILL.ser, P, `Nosotros ${BLANK} amigos.`, 'We are friends.', ['somos'], SER, 'nosotros somos — we are.', 0),
  conjugate('s-c-ellos', SKILL.ser, C, 'ser', 'ellos / ellas / ustedes', ['son'], SER, 'ellos, ellas and ustedes take son.', 0.3),
  cloze('s-c-mexico', SKILL.ser, C, `Yo ${BLANK} de México.`, 'I am from Mexico.', ['soy'], SER, 'Origin uses ser: yo soy de México.', 0),
  cloze('s-c-ustedes', SKILL.ser, C, `Ustedes ${BLANK} muy simpáticos.`, 'You (all) are very nice.', ['son'], SER, 'ustedes son — you (all) are.', 0.3),
  cloze('s-c-hermano', SKILL.ser, C, `Tú ${BLANK} mi hermano.`, 'You are my brother.', ['eres'], SER, 'tú eres — you are.', 0.2),
  cloze('s-d-estudiante', SKILL.ser, D, `Yo ${BLANK} estudiante.`, 'I am a student.', ['soy'], SER, 'yo soy — I am.', -0.5),

  // Estar.
  conjugate('e-yo', SKILL.estar, P, 'estar', 'yo', ['estoy'], ESTAR, 'yo estoy — I am (somewhere, or in some state).', -0.3),
  conjugate('e-tu', SKILL.estar, P, 'estar', 'tú', ['estás'], ESTAR, 'tú estás — with an accent on the a.', 0.2),
  conjugate('e-el', SKILL.estar, P, 'estar', 'él / ella / usted', ['está'], ESTAR, 'él, ella and usted take está — with an accent.', 0),
  cloze('e-estamos', SKILL.estar, P, `Nosotros ${BLANK} en casa.`, 'We are at home.', ['estamos'], ESTAR, 'nosotros estamos — we are.', 0),
  conjugate('e-c-ellos', SKILL.estar, C, 'estar', 'ellos / ellas / ustedes', ['están'], ESTAR, 'ellos, ellas and ustedes take están.', 0.3),
  cloze('e-c-donde', SKILL.estar, C, `¿Dónde ${BLANK} tú?`, 'Where are you?', ['estás'], ESTAR, '¿Dónde estás? — location uses estar.', 0.3),
  cloze('e-c-sopa', SKILL.estar, C, `La sopa ${BLANK} caliente.`, 'The soup is hot.', ['está'], ESTAR, 'A temporary state uses estar: la sopa está caliente.', 0.2),
  cloze('e-c-cansado', SKILL.estar, C, `Yo ${BLANK} cansado.`, 'I am tired.', ['estoy'], ESTAR, 'yo estoy cansado — a state, so estar.', 0),
  cloze('e-d-madrid', SKILL.estar, D, `Ellos ${BLANK} en Madrid.`, 'They are in Madrid.', ['están'], ESTAR, 'ellos están — location uses estar.', 0),

  // Ser or estar.
  choice('se-oficina', SKILL.serEstar, P, `María ${BLANK} en la oficina. (María is at the office.)`, ['es', 'está'], 1, SER_ESTAR, 'Location uses estar: María está en la oficina.', { 0: 'ser-for-location' }, 0),
  choice('se-doctora', SKILL.serEstar, P, `Ana ${BLANK} doctora. (Ana is a doctor.)`, ['es', 'está'], 0, SER_ESTAR, 'A profession uses ser: Ana es doctora.', { 1: 'estar-for-identity' }, 0),
  choice('se-cansado', SKILL.serEstar, P, `Pedro ${BLANK} cansado hoy. (Pedro is tired today.)`, ['es', 'está'], 1, SER_ESTAR, 'A temporary state uses estar: Pedro está cansado hoy.', { 0: 'ser-for-condition' }, 0.3),
  choice('se-espana', SKILL.serEstar, P, `Nosotros ${BLANK} de España. (We are from Spain.)`, ['somos', 'estamos'], 0, SER_ESTAR, 'Origin uses ser: somos de España.', { 1: 'estar-for-identity' }, 0.3),
  choice('se-c-padres', SKILL.serEstar, C, `Mis padres ${BLANK} en Madrid. (My parents are in Madrid.)`, ['son', 'están'], 1, SER_ESTAR, 'Location uses estar: están en Madrid.', { 0: 'ser-for-location' }, 0.3),
  choice('se-c-alto', SKILL.serEstar, C, `Tú ${BLANK} muy alto. (You are very tall.)`, ['eres', 'estás'], 0, SER_ESTAR, 'A lasting characteristic uses ser: eres muy alto.', { 1: 'estar-for-identity' }, 0.3),
  choice('se-c-cafe', SKILL.serEstar, C, `El café ${BLANK} frío. (The coffee is cold — it has cooled down.)`, ['es', 'está'], 1, SER_ESTAR, 'The coffee\'s current state uses estar: el café está frío.', { 0: 'ser-for-condition' }, 0.5),
  cloze('se-c-estudiantes', SKILL.serEstar, C, `Ellos ${BLANK} estudiantes.`, 'They are students.', ['son'], SER_ESTAR, 'What someone is uses ser: ellos son estudiantes.', 0.3),
  choice('se-d-parque', SKILL.serEstar, D, `Yo ${BLANK} en el parque. (I am in the park.)`, ['soy', 'estoy'], 1, SER_ESTAR, 'Location uses estar: estoy en el parque.', { 0: 'ser-for-location' }, 0),

  // Simple sentences.
  order('st-estudiante', SKILL.sentences, P, ['estudiante', 'soy', 'Yo'], 'I am a student.', ['Yo soy estudiante'], ORDER, 'Subject, verb, then the rest: Yo soy estudiante.', 0),
  order('st-casa', SKILL.sentences, P, ['aquí', 'casa', 'está', 'La'], 'The house is here.', ['La casa está aquí', 'Aquí está la casa'], ORDER, 'La casa está aquí — or, putting "aquí" first, Aquí está la casa.', 0.3),
  translate('st-buenos-dias', SKILL.sentences, P, 'Good morning, Ana.', ['Buenos días, Ana'], ORDER, 'Buenos días, Ana.', 0),
  translate('st-amigos', SKILL.sentences, P, 'We are friends.', ['Somos amigos', 'Nosotros somos amigos', 'Somos amigas', 'Nosotras somos amigas'], ORDER, 'Somos amigos — "nosotros" can be left out.', 0.3),
  translate('st-libro', SKILL.sentences, P, 'The book is on the table.', ['El libro está en la mesa', 'El libro está sobre la mesa'], ORDER, 'El libro está en la mesa: location, so estar.', 0.6),
  order('st-c-mexico', SKILL.sentences, C, ['México', 'es', 'Ella', 'de'], 'She is from Mexico.', ['Ella es de México'], ORDER, 'Ella es de México: origin uses ser.', 0.3),
  translate('st-c-casa', SKILL.sentences, C, 'I am at home.', ['Estoy en casa', 'Yo estoy en casa'], ORDER, 'Estoy en casa: location uses estar.', 0.3),
  translate('st-c-gracias', SKILL.sentences, C, 'Thank you, Pedro.', ['Gracias, Pedro'], ORDER, 'Gracias, Pedro.', 0),
  translate('st-c-cansadas', SKILL.sentences, C, 'The girls are tired.', ['Las chicas están cansadas', 'Las niñas están cansadas'], ORDER, 'Las chicas están cansadas: a state uses estar, and the adjective agrees (feminine plural).', 0.8),
  translate('st-d-hola', SKILL.sentences, D, 'Hello, I am Ana.', ['Hola, soy Ana', 'Hola, yo soy Ana'], ORDER, 'Hola, soy Ana.', 0),
]

const SKILLS: readonly SkillSpec[] = [
  { id: SKILL.greetings, title: 'Greetings and courtesy', kind: 'fact', environment: ENVIRONMENT, description: 'Hello, goodbye, please, thank you and asking how someone is.', objectives: ['Greet people at any time of day', 'Say please, thank you and you\'re welcome'] },
  { id: SKILL.articles, title: 'Articles and gender', kind: 'concept', environment: ENVIRONMENT, description: 'el, la, los, las, un, una — and the common exceptions.', objectives: ['Choose the article for a noun'] },
  { id: SKILL.ser, title: 'The verb ser', kind: 'procedure', environment: ENVIRONMENT, description: 'Present tense of ser (to be: identity).', objectives: ['Conjugate ser in the present'] },
  { id: SKILL.estar, title: 'The verb estar', kind: 'procedure', environment: ENVIRONMENT, description: 'Present tense of estar (to be: location and state).', objectives: ['Conjugate estar in the present'] },
  { id: SKILL.serEstar, title: 'Ser or estar?', kind: 'judgment', environment: ENVIRONMENT, requires: [SKILL.ser, SKILL.estar], description: 'Choosing between the two verbs "to be".', objectives: ['Use ser for identity and origin', 'Use estar for location and states'] },
  { id: SKILL.sentences, title: 'Simple sentences', kind: 'performance', environment: ENVIRONMENT, requires: [SKILL.greetings, SKILL.articles, SKILL.serEstar], description: 'Short sentences with greetings, articles, ser and estar.', objectives: ['Translate short sentences', 'Put words in order'] },
]

const LESSONS: readonly LessonSpec[] = [
  {
    id: 'es-greetings',
    skillId: SKILL.greetings,
    title: 'Greetings and courtesy',
    source: `# Greetings and courtesy

{% language-phrase text="hola" translation="hello" note="any time of day" /%}

{% language-phrase text="buenos días" translation="good morning" /%}

{% language-phrase text="buenas tardes" translation="good afternoon" /%}

{% language-phrase text="buenas noches" translation="good evening, good night" /%}

{% language-phrase text="adiós" translation="goodbye" /%}

{% language-phrase text="hasta luego" translation="see you later" /%}

{% callout kind="key-idea" title="Courtesy" %}
**por favor** is please, **gracias** is thank you, and the answer to gracias is **de nada** (you're welcome).
{% /callout %}

To ask a friend how they are, say **¿Cómo estás?** or **¿Qué tal?** Spanish questions open with ¿ and close with ?.

{% check question="What do you answer when someone says gracias?" options=[{id: "a", text: "de nada"}, {id: "b", text: "por favor"}, {id: "c", text: "adiós"}] answer="a" explain="De nada means you're welcome." /%}
`,
  },
  {
    id: 'es-articles',
    skillId: SKILL.articles,
    title: 'Articles and gender',
    source: `# Articles and gender

Every Spanish noun is masculine or feminine, and the article shows which.

- the: **el** (masculine), **la** (feminine), **los** and **las** in the plural
- a, an: **un** (masculine), **una** (feminine)

{% callout kind="key-idea" title="Endings" %}
Nouns ending in **-o** are usually masculine (el libro) and nouns ending in **-a** usually feminine (la casa). Learn the exceptions with their article: **la mano** (the hand), **el día** (the day).
{% /callout %}

{% worked-example title="Choosing the article" %}
1. Find the ending: perr**os** — masculine, plural.
2. Pick the article: **los** perros.
{% /worked-example %}

{% check question="Which article goes with mesa (table)?" options=[{id: "a", text: "el"}, {id: "b", text: "la"}] answer="b" explain="Mesa ends in -a and is feminine: la mesa." /%}
`,
  },
  {
    id: 'es-ser',
    skillId: SKILL.ser,
    title: 'The verb ser',
    source: `# The verb ser

**Ser** is "to be" for what someone or something *is*: name, profession, origin, character.

- yo **soy** — I am
- tú **eres** — you are
- él, ella, usted **es** — he, she is; you are (formal)
- nosotros **somos** — we are
- vosotros **sois** — you are (plural, Spain)
- ellos, ellas, ustedes **son** — they are; you are (plural)

{% callout kind="tip" title="No pronoun needed" %}
The verb form already shows the person, so "Soy estudiante" means I am a student.
{% /callout %}

{% check question="Which form goes with nosotros?" options=[{id: "a", text: "son"}, {id: "b", text: "somos"}, {id: "c", text: "es"}] answer="b" explain="nosotros somos — we are." /%}
`,
  },
  {
    id: 'es-estar',
    skillId: SKILL.estar,
    title: 'The verb estar',
    source: `# The verb estar

**Estar** is "to be" for *where* something is and *how* it is right now.

- yo **estoy**
- tú **estás**
- él, ella, usted **está**
- nosotros **estamos**
- vosotros **estáis**
- ellos, ellas, ustedes **están**

{% callout kind="warning" title="Accents" %}
estás, está, estáis and están carry an accent. Without it, **esta** means "this".
{% /callout %}

{% check question="Which form goes with yo?" options=[{id: "a", text: "está"}, {id: "b", text: "estás"}, {id: "c", text: "estoy"}] answer="c" explain="yo estoy — I am." /%}
`,
  },
  {
    id: 'es-ser-estar',
    skillId: SKILL.serEstar,
    title: 'Ser or estar?',
    source: `# Ser or estar?

{% callout kind="key-idea" title="The rule of thumb" %}
**Ser** for who or what: identity, profession, origin, character. **Estar** for where and how: location and temporary states.
{% /callout %}

{% worked-example title="Two sentences" %}
- Ana **es** profesora. — what she is: ser.
- Ana **está** en la escuela. — where she is: estar.
{% /worked-example %}

{% check question="Ana ___ en casa. (Ana is at home.)" options=[{id: "a", text: "es"}, {id: "b", text: "está"}] answer="b" explain="Location uses estar." /%}
`,
  },
  {
    id: 'es-sentences',
    skillId: SKILL.sentences,
    title: 'Simple sentences',
    source: `# Simple sentences

Spanish sentences usually go **subject, verb, rest**: *Ana es de México.* The subject pronoun is often left out: *Somos amigos* (we are friends).

{% language-phrase text="Estoy en casa." translation="I am at home." /%}

{% callout kind="tip" title="Agreement" %}
Adjectives agree with the noun: *el chico está cansado*, *las chicas están cansadas*.
{% /callout %}

{% check question="Which sentence means 'I am at home'?" options=[{id: "a", text: "Estoy en casa."}, {id: "b", text: "Soy en casa."}] answer="a" explain="Location uses estar: estoy en casa." /%}
`,
  },
]

/** The Spanish basics course. */
export function spanishCourse(): CourseSpec {
  return {
    id: 'spanish-basics',
    version: '1.0.0',
    title: 'Spanish basics',
    description: 'Greetings, articles and the two verbs "to be" (ser and estar) for English speakers starting Spanish.',
    keywords: ['spanish', 'español', 'learn spanish', 'vocabulary', 'greetings', 'articles', 'ser', 'estar', 'beginner', 'language'],
    language: 'en',
    goal: SKILL.sentences,
    environments: [ENVIRONMENT],
    preset: 'language-basics@1',
    skills: SKILLS,
    lessons: LESSONS,
    items: ITEMS,
  }
}

/** The content pack registered by the plugin. */
export function languagePack(): ContentPack {
  return { id: 'spanish-basics', version: '1.0.0', title: 'Spanish basics', courses: [spanishCourse()] }
}
