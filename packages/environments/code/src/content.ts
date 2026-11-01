/**
 * The shipped course "Python: reading and tracing code". Hand-written; every
 * expected output (exercise keys and lesson snippets) is checked by running
 * the program with CPython (`pnpm verify:snippets`), and the result is
 * recorded per program set (see `verification.ts`). Lesson programs are not
 * exercise programs.
 * @module @hodos/code/content
 */
import type { ContentPack, CourseSpec, ExerciseItem, ExerciseMode, LessonSpec, SkillSpec } from '@hodos/plugin-sdk'
import { OUTPUT_MISCONCEPTIONS } from './grader.js'
import { ENVIRONMENT, KIND } from './kinds.js'

/** Skill ids. */
export const SKILL = {
  expressions: 'py.expressions',
  variables: 'py.variables',
  conditionals: 'py.conditionals',
  loops: 'py.loops',
  lists: 'py.lists',
  functions: 'py.functions',
} as const

const P: readonly ExerciseMode[] = ['practice', 'review']
const C: readonly ExerciseMode[] = ['checkpoint']
const D: readonly ExerciseMode[] = ['diagnostic']

/** Feedback per misconception (none states an answer). */
export const FEEDBACK: Readonly<Record<string, string>> = {
  'true-division': 'In Python 3, / always gives a float: 7 / 2 is 3.5 and 6 / 2 is 3.0. Use // to divide and round down to a whole number.',
  'floor-division': '// divides and rounds down to a whole number: 7 // 2 is 3.',
  'operator-precedence': 'Brackets first, then **, then * / // %, then + and -. So 1 + 2 * 3 is 7.',
  'left-to-right': 'Operators of the same level are applied from left to right: 8 // 2 * 2 is (8 // 2) * 2.',
  'power-operator': '** raises to a power: 3 ** 2 is 3 × 3.',
  'string-concatenation': 'Text in quotes is a string even when it holds digits: + joins strings end to end instead of adding numbers.',
  'assignment-links': 'An assignment copies the value the right side has at that moment; changing a variable later does not change the copy.',
  'sequential-update': 'Each line uses the values the variables have at that moment, after all the lines above it ran.',
  'simultaneous-assignment': 'Assignments run one after another: once a holds b\'s value, b = a gives b that same value back.',
  'augmented-assignment': 'total += 5 means total = total + 5: it changes total.',
  'all-true-branches': 'In an if/elif/else chain only the first branch whose condition is true runs; the others are skipped.',
  'indentation-blocks': 'Every line indented under an if belongs to it: they all run, or they are all skipped.',
  'separate-ifs': 'Two separate if statements are checked independently; an else belongs only to the if just above it.',
  'and-or': 'and is true only when both sides are true; or is true when at least one side is true.',
  'condition-current-value': 'A condition is checked when the program reaches it, with the values the variables have then.',
  'range-end-included': 'range stops before its end: range(1, 4) gives 1, 2 and 3.',
  'range-start': 'range(n) starts at 0: range(4) gives 0, 1, 2 and 3.',
  'print-in-loop': 'Only the indented lines repeat. A print after the loop, not indented, runs once when the loop is over.',
  'while-condition-check': 'The condition is checked before each pass. The pass that makes it false still runs to its end; the loop stops at the next check.',
  'accumulator-reset': 'A variable set to 0 inside the loop starts over on every pass; set it before the loop to keep a running total.',
  'index-from-one': 'Indexes start at 0: xs[0] is the first item and xs[1] the second.',
  'slice-end-included': 'A slice stops before its end index: xs[1:3] holds the items at indexes 1 and 2.',
  aliasing: 'b = a does not copy a list: b becomes a second name for the same list, so a change made through b shows through a too.',
  'return-vs-print': 'print shows a value; return hands it back to the caller. A function that never returns a value gives back None.',
  'local-scope': 'Variables assigned inside a function, its parameters included, are local: they do not change variables outside it.',
  'return-ends-function': 'return ends the function at once, even inside a loop; nothing after it in the function runs.',
  ...OUTPUT_MISCONCEPTIONS,
}

/** First hint per skill: the rule to apply. */
const RULE: Readonly<Record<string, string>> = {
  [SKILL.expressions]: 'Work out each print on its own: brackets first, then **, then * / // %, then + and -. / gives a float, // rounds down and % is the remainder.',
  [SKILL.variables]: 'Trace the variables in a table: go line by line and write down each new value.',
  [SKILL.conditionals]: 'Check the conditions from the top with the current values; only the first true branch of an if/elif/else chain runs.',
  [SKILL.loops]: 'List the values the loop variable takes, then run the indented lines once for each; range stops before its end.',
  [SKILL.lists]: 'Indexes start at 0, slices stop before their end index, and b = a makes b another name for the same list.',
  [SKILL.functions]: 'Follow each call into the function and back: return hands a value back, print only shows it, and no return means None.',
}

/** A program and what it prints. */
export interface Snippet {
  /** Item id, or lesson id and number for lesson programs. */
  readonly id: string
  readonly source: string
  readonly output: string
}

interface PredictSpec extends Snippet {
  readonly skill: string
  readonly modes: readonly ExerciseMode[]
  readonly misconceptions?: ReadonlyArray<readonly [string, string]>
  /** Second hint: where to look. */
  readonly step?: string
  readonly explanation: string
  readonly difficulty?: number
  readonly highlight?: readonly number[]
}

const code = (...lines: readonly string[]): string => lines.join('\n')

const SPECS: readonly PredictSpec[] = [
  // Expressions and operators
  {
    id: 'ex-1', skill: SKILL.expressions, modes: P, difficulty: -1,
    source: code('print(7 / 2)', 'print(7 // 2)', 'print(7 % 2)'), output: code('3.5', '3', '1'),
    misconceptions: [[code('3', '3', '1'), 'true-division'], [code('3.5', '3.5', '1'), 'floor-division']],
    explanation: '7 / 2 is 3.5 (/ always gives a float), 7 // 2 rounds down to 3, and 7 % 2 is the remainder, 1.',
  },
  {
    id: 'ex-2', skill: SKILL.expressions, modes: P, difficulty: -0.5,
    source: code('print("3" + "4")', 'print(3 + 4)', 'print("ab" * 3)'), output: code('34', '7', 'ababab'),
    misconceptions: [[code('7', '7', 'ababab'), 'string-concatenation']],
    step: 'Which values are in quotes? Those are strings, not numbers.',
    explanation: '"3" + "4" joins two strings into 34, 3 + 4 adds numbers to 7, and "ab" * 3 repeats the string three times.',
  },
  {
    id: 'ex-3', skill: SKILL.expressions, modes: P, difficulty: 0,
    source: code('print(2 + 3 * 4)', 'print((2 + 3) * 4)', 'print(2 ** 3)'), output: code('14', '20', '8'),
    misconceptions: [[code('20', '20', '8'), 'operator-precedence'], [code('14', '20', '6'), 'power-operator']],
    explanation: '3 * 4 comes first, so 2 + 12 is 14; the brackets make it 5 * 4 = 20; and 2 ** 3 is 2 × 2 × 2 = 8.',
  },
  {
    id: 'ex-c1', skill: SKILL.expressions, modes: C, difficulty: 0,
    source: code('print(9 / 3)', 'print(9 // 2)', 'print(9 % 4)'), output: code('3.0', '4', '1'),
    misconceptions: [[code('3', '4', '1'), 'true-division'], [code('3.0', '4.5', '1'), 'floor-division']],
    explanation: '9 / 3 is the float 3.0, 9 // 2 rounds 4.5 down to 4, and 9 % 4 is the remainder, 1.',
  },
  {
    id: 'ex-c2', skill: SKILL.expressions, modes: C, difficulty: 0.5,
    source: code('print(10 - 4 / 2)', 'print(12 // 4 * 3)', 'print(2 * 3 ** 2)'), output: code('8.0', '9', '18'),
    misconceptions: [
      [code('3.0', '9', '18'), 'operator-precedence'], [code('8', '9', '18'), 'true-division'],
      [code('8.0', '1', '18'), 'left-to-right'], [code('8.0', '9', '36'), 'operator-precedence'],
    ],
    explanation: '4 / 2 is 2.0, so 10 - 2.0 is 8.0; 12 // 4 is 3 and 3 * 3 is 9; 3 ** 2 is 9 and 2 * 9 is 18.',
  },
  {
    id: 'ex-c3', skill: SKILL.expressions, modes: C, difficulty: -0.3,
    source: code('print("5" + "5")', 'print(5 + 5)', 'print("5" * 3)'), output: code('55', '10', '555'),
    misconceptions: [[code('10', '10', '15'), 'string-concatenation']],
    explanation: '"5" + "5" joins two strings into 55, 5 + 5 is 10, and "5" * 3 repeats the string: 555.',
  },
  {
    id: 'ex-d1', skill: SKILL.expressions, modes: D, difficulty: -0.5,
    source: code('print(8 / 4)', 'print(2 + 3 * 2)'), output: code('2.0', '8'),
    misconceptions: [[code('2', '8'), 'true-division'], [code('2.0', '10'), 'operator-precedence']],
    explanation: '8 / 4 is the float 2.0, and 3 * 2 comes before the addition: 2 + 6 = 8.',
  },

  // Variables and assignment
  {
    id: 'var-1', skill: SKILL.variables, modes: P, difficulty: -0.5,
    source: code('x = 5', 'y = x', 'x = 8', 'print(x, y)'), output: '8 5',
    misconceptions: [['8 8', 'assignment-links']],
    explanation: 'y = x copies 5 into y; giving x a new value afterwards does not change y.',
  },
  {
    id: 'var-2', skill: SKILL.variables, modes: P, difficulty: 0,
    source: code('count = 1', 'count = count + 2', 'count = count * 3', 'print(count)'), output: '9',
    misconceptions: [['3', 'sequential-update']],
    explanation: 'count becomes 1 + 2 = 3, then 3 * 3 = 9.',
  },
  {
    id: 'var-3', skill: SKILL.variables, modes: P, difficulty: 0.3,
    source: code('a = 1', 'b = 2', 'a = b', 'b = a', 'print(a, b)'), output: '2 2',
    misconceptions: [['2 1', 'simultaneous-assignment']],
    step: 'What does a hold right after line 3 runs?',
    explanation: 'After a = b, a is 2; then b = a gives b the value 2 again. Both are 2: the values were not swapped.',
  },
  {
    id: 'var-c1', skill: SKILL.variables, modes: C, difficulty: -0.3,
    source: code('total = 10', 'total += 5', 'total -= 3', 'print(total)'), output: '12',
    misconceptions: [['10', 'augmented-assignment']],
    explanation: 'total becomes 10 + 5 = 15, then 15 - 3 = 12.',
  },
  {
    id: 'var-c2', skill: SKILL.variables, modes: C, difficulty: 0,
    source: code('name = "Ada"', 'greeting = "Hi " + name', 'name = "Bob"', 'print(greeting)'), output: 'Hi Ada',
    misconceptions: [['Hi Bob', 'assignment-links']],
    explanation: 'greeting was built when name was "Ada"; changing name afterwards does not change greeting.',
  },
  {
    id: 'var-c3', skill: SKILL.variables, modes: C, difficulty: 0.5,
    source: code('x = 3', 'y = x * 2', 'x = y + 1', 'y = x - y', 'print(x, y)'), output: '7 1',
    misconceptions: [['7 -3', 'sequential-update']],
    explanation: 'y = 6, then x = 6 + 1 = 7, then y = 7 - 6 = 1.',
  },
  {
    id: 'var-d1', skill: SKILL.variables, modes: D, difficulty: -0.5,
    source: code('a = 4', 'b = a', 'a = a + 1', 'print(a, b)'), output: '5 4',
    misconceptions: [['5 5', 'assignment-links']],
    explanation: 'b got a copy of 4; a then becomes 5.',
  },

  // Branches
  {
    id: 'if-1', skill: SKILL.conditionals, modes: P, difficulty: -0.3,
    source: code('score = 72', 'if score >= 90:', '    print("A")', 'elif score >= 70:', '    print("B")', 'elif score >= 50:', '    print("C")', 'else:', '    print("F")'),
    output: 'B',
    misconceptions: [[code('B', 'C'), 'all-true-branches']],
    explanation: '72 >= 90 is false and 72 >= 70 is true, so only B is printed; the rest of the chain is skipped.',
  },
  {
    id: 'if-2', skill: SKILL.conditionals, modes: P, difficulty: 0,
    source: code('x = 4', 'if x > 5:', '    print("big")', '    print("really big")', 'print("done")'), output: 'done',
    misconceptions: [[code('really big', 'done'), 'indentation-blocks']],
    explanation: '4 > 5 is false, so both indented lines are skipped; print("done") is not indented and always runs.',
  },
  {
    id: 'if-3', skill: SKILL.conditionals, modes: P, difficulty: 0.3,
    source: code('n = 7', 'if n % 2 == 0:', '    print("even")', 'else:', '    print("odd")', 'if n > 5:', '    print("big")'), output: code('odd', 'big'),
    misconceptions: [['odd', 'separate-ifs']],
    explanation: '7 % 2 is 1, so the first if prints odd. The second if is a separate statement: 7 > 5, so it prints big.',
  },
  {
    id: 'if-c1', skill: SKILL.conditionals, modes: C, difficulty: 0,
    source: code('t = 15', 'if t > 25:', '    print("hot")', 'elif t > 10:', '    print("mild")', 'elif t > 0:', '    print("cold")', 'else:', '    print("freezing")'),
    output: 'mild',
    misconceptions: [[code('mild', 'cold'), 'all-true-branches']],
    explanation: '15 > 25 is false and 15 > 10 is true, so only mild is printed.',
  },
  {
    id: 'if-c2', skill: SKILL.conditionals, modes: C, difficulty: 0.3,
    source: code('age = 15', 'member = True', 'if age >= 18 and member:', '    print("full")', 'elif age >= 13 or member:', '    print("teen")', 'else:', '    print("child")'),
    output: 'teen',
    misconceptions: [['full', 'and-or']],
    explanation: 'age >= 18 is false, so the and is false; age >= 13 is true, so the or is true and teen is printed.',
  },
  {
    id: 'if-c3', skill: SKILL.conditionals, modes: C, difficulty: 0.5,
    source: code('x = 10', 'if x > 5:', '    x = x - 6', 'if x > 5:', '    print("still big")', 'else:', '    print("small now")', 'print(x)'),
    output: code('small now', '4'),
    misconceptions: [[code('still big', '4'), 'condition-current-value']],
    explanation: 'The first if makes x 4. The second if is checked with x = 4, so it prints small now, then 4.',
  },
  {
    id: 'if-d1', skill: SKILL.conditionals, modes: D, difficulty: -0.5,
    source: code('n = 12', 'if n > 10:', '    print("over ten")', 'elif n > 5:', '    print("over five")'), output: 'over ten',
    misconceptions: [[code('over ten', 'over five'), 'all-true-branches']],
    explanation: '12 > 10 is true, so the first branch runs and the elif is skipped.',
  },

  // Loops
  {
    id: 'loop-1', skill: SKILL.loops, modes: P, difficulty: -0.5,
    source: code('for i in range(1, 4):', '    print(i)'), output: code('1', '2', '3'),
    misconceptions: [[code('1', '2', '3', '4'), 'range-end-included']],
    explanation: 'range(1, 4) gives 1, 2 and 3: it stops before 4.',
  },
  {
    id: 'loop-2', skill: SKILL.loops, modes: P, difficulty: 0,
    source: code('total = 0', 'for n in range(4):', '    total = total + n', 'print(total)'), output: '6',
    misconceptions: [['10', 'range-end-included'], [code('0', '1', '3', '6'), 'print-in-loop']],
    explanation: 'n takes 0, 1, 2 and 3, so total is 0 + 1 + 2 + 3 = 6, printed once after the loop.',
  },
  {
    id: 'loop-3', skill: SKILL.loops, modes: P, difficulty: 0.3,
    source: code('n = 1', 'while n < 20:', '    n = n * 2', 'print(n)'), output: '32',
    misconceptions: [['16', 'while-condition-check']],
    step: 'Write down n after each pass, and check the condition before the next one.',
    explanation: 'n goes 2, 4, 8, 16, 32. 16 < 20 is still true, so one more pass makes it 32; then 32 < 20 is false.',
  },
  {
    id: 'loop-c1', skill: SKILL.loops, modes: C, difficulty: 0,
    source: code('for i in range(2, 8, 2):', '    print(i)'), output: code('2', '4', '6'),
    misconceptions: [[code('2', '4', '6', '8'), 'range-end-included']],
    explanation: 'range(2, 8, 2) counts 2, 4, 6 and stops before 8.',
  },
  {
    id: 'loop-c2', skill: SKILL.loops, modes: C, difficulty: 0.3,
    source: code('total = 0', 'for i in range(3):', '    total = 0', '    total = total + i', 'print(total)'), output: '2',
    misconceptions: [['3', 'accumulator-reset']],
    explanation: 'total is set back to 0 on every pass, so after the last pass (i = 2) it is 0 + 2 = 2.',
  },
  {
    id: 'loop-c3', skill: SKILL.loops, modes: C, difficulty: 0.5,
    source: code('x = 10', 'while x > 0:', '    print(x)', '    x = x - 4'), output: code('10', '6', '2'),
    misconceptions: [[code('10', '6', '2', '-2'), 'while-condition-check']],
    explanation: 'It prints 10, 6 and 2; then x becomes -2, the condition x > 0 is false, and the loop stops before printing it.',
  },
  {
    id: 'loop-d1', skill: SKILL.loops, modes: D, difficulty: -0.5,
    source: code('for i in range(3):', '    print(i)'), output: code('0', '1', '2'),
    misconceptions: [[code('1', '2', '3'), 'range-start'], [code('0', '1', '2', '3'), 'range-end-included']],
    explanation: 'range(3) gives 0, 1 and 2.',
  },

  // Lists
  {
    id: 'list-1', skill: SKILL.lists, modes: P, difficulty: -0.5,
    source: code('xs = [10, 20, 30, 40]', 'print(xs[1])', 'print(xs[-1])', 'print(len(xs))'), output: code('20', '40', '4'),
    misconceptions: [[code('10', '40', '4'), 'index-from-one']],
    explanation: 'xs[1] is the second item, 20; xs[-1] is the last, 40; and the list has 4 items.',
  },
  {
    id: 'list-2', skill: SKILL.lists, modes: P, difficulty: 0,
    source: code('xs = [3, 1, 2]', 'xs.append(5)', 'print(xs)', 'print(xs[1:3])'), output: code('[3, 1, 2, 5]', '[1, 2]'),
    misconceptions: [[code('[3, 1, 2, 5]', '[1, 2, 5]'), 'slice-end-included']],
    explanation: 'append adds 5 at the end; xs[1:3] holds the items at indexes 1 and 2.',
  },
  {
    id: 'list-3', skill: SKILL.lists, modes: P, difficulty: 0.3,
    source: code('a = [1, 2]', 'b = a', 'b.append(3)', 'print(a)'), output: '[1, 2, 3]',
    misconceptions: [['[1, 2]', 'aliasing']],
    explanation: 'a and b name the same list, so appending through b changes the list a names too.',
  },
  {
    id: 'list-c1', skill: SKILL.lists, modes: C, difficulty: 0,
    source: code('words = ["red", "green", "blue"]', 'print(words[0])', 'print(words)'), output: code('red', "['red', 'green', 'blue']"),
    misconceptions: [[code('green', "['red', 'green', 'blue']"), 'index-from-one']],
    explanation: 'words[0] is the string red, printed without quotes; printing the whole list shows each string with quotes.',
  },
  {
    id: 'list-c2', skill: SKILL.lists, modes: C, difficulty: 0.3,
    source: code('nums = [4, 8, 15, 16]', 'total = 0', 'for n in nums[1:]:', '    total += n', 'print(total)'), output: '39',
    misconceptions: [['43', 'index-from-one']],
    explanation: 'nums[1:] skips the first item, so total is 8 + 15 + 16 = 39.',
  },
  {
    id: 'list-c3', skill: SKILL.lists, modes: C, difficulty: 0.5,
    source: code('xs = [5, 6, 7]', 'ys = xs', 'ys[0] = 9', 'print(xs[0] + ys[0])'), output: '18',
    misconceptions: [['14', 'aliasing']],
    explanation: 'xs and ys are one list, so after ys[0] = 9 both xs[0] and ys[0] are 9: 18.',
  },
  {
    id: 'list-d1', skill: SKILL.lists, modes: D, difficulty: -0.3,
    source: code('xs = ["a", "b", "c", "d"]', 'print(xs[2])', 'print(xs[1:3])'), output: code('c', "['b', 'c']"),
    misconceptions: [[code('b', "['a', 'b']"), 'index-from-one'], [code('c', "['b', 'c', 'd']"), 'slice-end-included']],
    explanation: 'xs[2] is the third item, c; xs[1:3] holds the items at indexes 1 and 2.',
  },

  // Functions
  {
    id: 'fn-1', skill: SKILL.functions, modes: P, difficulty: 0,
    source: code('def double(n):', '    print(n * 2)', '', 'result = double(4)', 'print(result)'), output: code('8', 'None'),
    misconceptions: [[code('8', '8'), 'return-vs-print'], ['8', 'return-vs-print']],
    explanation: 'double prints 8 but has no return, so it gives back None, and print(result) prints None.',
  },
  {
    id: 'fn-2', skill: SKILL.functions, modes: P, difficulty: 0.3,
    source: code('x = 1', '', 'def change():', '    x = 5', '    return x', '', 'print(change())', 'print(x)'), output: code('5', '1'),
    misconceptions: [[code('5', '5'), 'local-scope']],
    explanation: 'The x inside change is a separate, local variable: the function returns 5, and the outer x is still 1.',
  },
  {
    id: 'fn-3', skill: SKILL.functions, modes: P, difficulty: 0.5,
    source: code('def total(xs):', '    s = 0', '    for x in xs:', '        s += x', '        return s', '', 'print(total([3, 4, 5]))'), output: '3',
    misconceptions: [['12', 'return-ends-function']],
    step: 'Look at how far return is indented.',
    explanation: 'return is inside the loop, so the function returns on the first pass, when s is 3.',
  },
  {
    id: 'fn-c1', skill: SKILL.functions, modes: C, difficulty: 0,
    source: code('def show(x):', '    print("x is", x)', '', 'y = show(3)', 'print(y)'), output: code('x is 3', 'None'),
    misconceptions: [[code('x is 3', '3'), 'return-vs-print'], ['x is 3', 'return-vs-print']],
    explanation: 'show prints x is 3 and returns nothing, so y is None.',
  },
  {
    id: 'fn-c2', skill: SKILL.functions, modes: C, difficulty: 0.3,
    source: code('count = 0', '', 'def bump(count):', '    count = count + 1', '    return count', '', 'bump(count)', 'print(count)', 'print(bump(count))'),
    output: code('0', '1'),
    misconceptions: [[code('1', '2'), 'local-scope']],
    explanation: 'The parameter count is local: bump returns 1 but the outer count stays 0, and the first result is not used.',
  },
  {
    id: 'fn-c3', skill: SKILL.functions, modes: C, difficulty: 0.5,
    source: code('def first_even(xs):', '    for x in xs:', '        if x % 2 == 0:', '            return x', '    return -1', '', 'print(first_even([3, 7, 8, 10]))', 'print(first_even([1, 5]))'),
    output: code('8', '-1'),
    misconceptions: [[code('10', '-1'), 'return-ends-function']],
    explanation: 'The function returns as soon as it meets 8; for [1, 5] the loop ends without an even number and it returns -1.',
  },
  {
    id: 'fn-d1', skill: SKILL.functions, modes: D, difficulty: -0.3,
    source: code('def add(a, b):', '    return a + b', '', 'print(add(2, 3))', 'print(add("2", "3"))'), output: code('5', '23'),
    misconceptions: [[code('5', '5'), 'string-concatenation']],
    explanation: 'add returns a + b: 5 for numbers, and the joined string 23 for strings.',
  },
]

function predictItem(spec: PredictSpec, verified: ReadonlySet<string>): ExerciseItem {
  const ids = [...new Set([...(spec.misconceptions ?? []).map(([, id]) => id), ...Object.keys(OUTPUT_MISCONCEPTIONS)])]
  return {
    id: spec.id,
    kind: KIND.predict,
    skills: [{ skillId: spec.skill, weight: 1 }],
    difficulty: spec.difficulty ?? 0,
    modes: [...spec.modes],
    payload: { language: 'python', source: spec.source, ...(spec.highlight === undefined ? {} : { highlight: [...spec.highlight] }) },
    key: { output: spec.output, ...(spec.misconceptions === undefined ? {} : { misconceptions: spec.misconceptions.map(([output, id]) => ({ output, id })) }) },
    hints: [
      { level: 1, text: RULE[spec.skill] ?? 'Trace the program line by line.' },
      ...(spec.step === undefined ? [] : [{ level: 2 as const, text: spec.step }]),
      { level: 5, text: `It prints:\n${spec.output}` },
    ],
    explanation: spec.explanation,
    misconceptionFeedback: Object.fromEntries(ids.flatMap(id => {
      const text = FEEDBACK[id]
      return text === undefined ? [] : [[id, text] as const]
    })),
    provenance: { source: 'authored', ...(verified.has(spec.id) ? { verifiedBy: ['cpython'] } : {}) },
  }
}

/** Lesson programs with their output, by lesson. */
const LESSON_SNIPPETS: Readonly<Record<string, readonly Snippet[]>> = {
  'py-expressions': [
    { id: 'py-expressions/1', source: code('print(10 / 4)', 'print(10 // 4)', 'print(10 % 4)', 'print(2 ** 5)'), output: code('2.5', '2', '2', '32') },
    { id: 'py-expressions/2', source: code('print("py" + "thon")', 'print("-" * 5)'), output: code('python', '-----') },
  ],
  'py-variables': [
    { id: 'py-variables/1', source: code('price = 4', 'qty = 3', 'cost = price * qty', 'qty = 10', 'print(cost)'), output: '12' },
  ],
  'py-conditionals': [
    { id: 'py-conditionals/1', source: code('temp = 30', 'if temp > 25:', '    print("warm")', 'elif temp > 15:', '    print("mild")', 'else:', '    print("cold")', 'print("bye")'), output: code('warm', 'bye') },
  ],
  'py-loops': [
    { id: 'py-loops/1', source: code('for k in range(2, 5):', '    print(k)'), output: code('2', '3', '4') },
    { id: 'py-loops/2', source: code('n = 3', 'while n > 0:', '    print(n)', '    n -= 1', 'print("go")'), output: code('3', '2', '1', 'go') },
  ],
  'py-lists': [
    { id: 'py-lists/1', source: code('fruits = ["fig", "kiwi", "plum"]', 'print(fruits[0], fruits[-1])', 'print(fruits[0:2])', 'fruits.append("pear")', 'print(len(fruits))'), output: code('fig plum', "['fig', 'kiwi']", '4') },
    { id: 'py-lists/2', source: code('p = [1]', 'q = p', 'q.append(2)', 'print(p)'), output: '[1, 2]' },
  ],
  'py-functions': [
    { id: 'py-functions/1', source: code('def square(n):', '    return n * n', '', 'print(square(3) + square(4))'), output: '25' },
    { id: 'py-functions/2', source: code('def say(n):', '    print(n)', '', 'r = say(2)', 'print(r)'), output: code('2', 'None') },
  ],
}

function snippetOf(lesson: string, n: number): Snippet {
  const found = LESSON_SNIPPETS[lesson]?.[n - 1]
  if (found === undefined) throw new Error(`no snippet ${lesson}/${n}`)
  return found
}

/** A `code-snippet` block for a lesson program. */
const block = (lesson: string, n: number, extra = ''): string => {
  const s = snippetOf(lesson, n)
  return `{% code-snippet source=${JSON.stringify(s.source)} output=${JSON.stringify(s.output)}${extra} /%}`
}

const check = (question: string, options: readonly string[], answer: number, explain: string): string =>
  `{% check question=${JSON.stringify(question)} options=[${options.map((o, i) => `{id: "${String.fromCharCode(97 + i)}", text: ${JSON.stringify(o)}}`).join(', ')}] answer="${String.fromCharCode(97 + answer)}" explain=${JSON.stringify(explain)} /%}`

const LESSONS: readonly LessonSpec[] = [
  {
    id: 'py-expressions', skillId: SKILL.expressions, title: 'Expressions and operators',
    source: `# Expressions and operators

Python works out an expression, and \`print\` shows the result. There are three kinds of division:

${block('py-expressions', 1)}

- \`/\` always gives a float (a number with a decimal point), even when the division comes out even.
- \`//\` divides and rounds down to a whole number; \`%\` gives the remainder.
- \`**\` raises to a power.

{% callout kind="key-idea" title="Order of operations" %}
Brackets first, then \`**\`, then \`*\`, \`/\`, \`//\` and \`%\`, then \`+\` and \`-\`. Operators of the same level go from left to right.
{% /callout %}

Strings (text in quotes) have operators too: \`+\` joins them and \`*\` repeats them.

${block('py-expressions', 2)}

${check('What does print(9 // 2) show?', ['4', '4.5', '5'], 0, '// rounds down: 9 // 2 is 4.')}
`,
  },
  {
    id: 'py-variables', skillId: SKILL.variables, title: 'Variables and assignment',
    source: `# Variables and assignment

\`name = value\` works out the value on the right first, then stores it under the name on the left. A later assignment replaces the stored value.

${block('py-variables', 1, ' highlight=[3]')}

\`cost\` got 4 × 3 = 12 when line 3 ran; changing \`qty\` afterwards does not change \`cost\`.

{% callout kind="tip" title="Trace with a table" %}
Write one column per variable, go line by line, and write down each new value.
{% /callout %}

\`total += 5\` is short for \`total = total + 5\`; \`-=\`, \`*=\` and \`/=\` work the same way.

${check('After a = 2, then b = a, then a = 7, what is b?', ['2', '7'], 0, 'b got the value a had at that moment: 2.')}
`,
  },
  {
    id: 'py-conditionals', skillId: SKILL.conditionals, title: 'Branches: if, elif and else',
    source: `# Branches: if, elif and else

An \`if\` runs its indented lines only when its condition is true; \`elif\` and \`else\` add more branches.

${block('py-conditionals', 1)}

{% callout kind="key-idea" title="Only the first true branch" %}
Python checks the conditions from the top and runs only the first branch whose condition is true. Here \`temp > 15\` is true as well, but its branch is skipped.
{% /callout %}

\`and\` needs both sides to be true; \`or\` needs at least one. Lines that are not indented under the \`if\` run either way.

${check('If two conditions in one if/elif chain are true, how many branches run?', ['Only the first true one', 'Both of them'], 0, 'Python stops at the first true condition.')}
`,
  },
  {
    id: 'py-loops', skillId: SKILL.loops, title: 'Loops: for and while',
    source: `# Loops: for and while

A \`for\` loop runs its indented lines once for each value. \`range\` makes the values, and it stops **before** its end:

${block('py-loops', 1)}

\`range(n)\` counts 0, 1, … up to n − 1; \`range(a, b, step)\` counts from a in steps of step, stopping before b.

A \`while\` loop checks its condition before each pass and stops as soon as it is false:

${block('py-loops', 2)}

{% callout kind="tip" title="Running totals" %}
Set the total to 0 before the loop and add to it inside the loop; print it after the loop to see it once.
{% /callout %}

${check('Which numbers does range(1, 4) give?', ['1, 2, 3', '1, 2, 3, 4'], 0, 'range stops before its end.')}
`,
  },
  {
    id: 'py-lists', skillId: SKILL.lists, title: 'Lists',
    source: `# Lists

A list holds values in order. Indexes start at 0, and negative indexes count from the end.

${block('py-lists', 1)}

- A slice \`xs[a:b]\` holds the items from index a up to, but not including, index b.
- Printing a list shows the strings in it with quotes; printing a string on its own shows no quotes.

{% callout kind="warning" title="Two names, one list" %}
\`q = p\` does not copy a list: both names refer to the same list.
{% /callout %}

${block('py-lists', 2)}

${check('xs = [5, 6, 7]. What is xs[1]?', ['6', '5'], 0, 'Index 0 is the first item, so index 1 is the second: 6.')}
`,
  },
  {
    id: 'py-functions', skillId: SKILL.functions, title: 'Functions',
    source: `# Functions

\`def\` defines a function. Calling it runs its body with the arguments in its parameters, and \`return\` hands a value back to the caller.

${block('py-functions', 1)}

{% callout kind="key-idea" title="return is not print" %}
\`print\` shows a value on the screen; \`return\` gives it back to the code that called the function. A function that ends without \`return\` gives back \`None\`.
{% /callout %}

${block('py-functions', 2)}

Variables created inside a function, and its parameters, are local: they do not change variables outside it.

${check('What does a function without a return statement give back?', ['None', '0', 'Nothing at all'], 0, 'It returns None.')}
`,
  },
]

const SKILLS: readonly SkillSpec[] = [
  { id: SKILL.expressions, title: 'Expressions and operators', kind: 'procedure', environment: ENVIRONMENT, description: 'Arithmetic (/, //, %, **), operator order, and + and * on strings.' },
  { id: SKILL.variables, title: 'Variables and assignment', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.expressions], description: 'Trace assignments and reassignments line by line.' },
  { id: SKILL.conditionals, title: 'Branches', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.variables], description: 'if, elif and else chains, and and or.' },
  { id: SKILL.loops, title: 'Loops', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.conditionals], description: 'for loops over range, while loops, running totals.' },
  { id: SKILL.lists, title: 'Lists', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.loops], description: 'Indexes, slices, append, and two names for one list.' },
  { id: SKILL.functions, title: 'Functions', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.lists], description: 'Calls, return versus print, None, local variables.' },
]

/** Every program with a known output: exercise keys and lesson snippets. */
export function snippets(): Snippet[] {
  return [...SPECS.map(s => ({ id: s.id, source: s.source, output: s.output })), ...Object.values(LESSON_SNIPPETS).flat()]
}

/**
 * "Python: reading and tracing code".
 * @param verified - ids whose output CPython confirmed (marked `verifiedBy: ['cpython']`).
 * @returns the course.
 */
export function tracingCourse(verified: ReadonlySet<string> = new Set()): CourseSpec {
  return {
    id: 'python-tracing', version: '1.0.0',
    title: 'Python: reading and tracing code',
    description: 'Predict what short Python programs print: expressions, variables, branches, loops, lists and functions.',
    keywords: ['python', 'programming', 'coding', 'code', 'tracing', 'trace', 'variables', 'loops', 'lists', 'functions', 'beginner'],
    language: 'en', goal: SKILL.functions, environments: [ENVIRONMENT], preset: 'code-reading@1',
    skills: SKILLS, lessons: LESSONS, items: SPECS.map(s => predictItem(s, verified)),
  }
}

/**
 * The content pack registered by the plugin.
 * @param verified - ids whose output CPython confirmed.
 * @returns the pack.
 */
export function codePack(verified: ReadonlySet<string> = new Set()): ContentPack {
  return { id: 'python-basics', version: '1.0.0', title: 'Python basics', courses: [tracingCourse(verified)] }
}
