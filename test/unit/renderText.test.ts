/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {Hash} from '../../src/vs/workbench/contrib/sapling/common/types.js';

import {Ancestor, AncestorType} from '../../src/vs/workbench/contrib/sapling/common/render.js';
import {TextRenderer} from '../../src/vs/workbench/contrib/sapling/common/renderText.js';

/* Ported from fbcode/eden/scm/lib/renderdag/src/box_drawing.rs */

type TestFixture = {
  rows: Array<[Hash, string[], string]>;
  reserve?: Hash[];
};

/*
                   A----B-D-----E----------F-\
                    \-C--/       \-W  \-X     \-Y-Z
*/
export const TEST_ANCESTORS: TestFixture = {
  reserve: ['F'],
  rows: [
    ['Z', ['P:Y'], 'Z'],
    ['Y', ['P:F'], 'Y'],
    ['F', ['A:E'], 'F'],
    ['X', ['P:E'], 'X'],
    ['W', ['P:E'], 'W'],
    ['E', ['A:D'], 'E'],
    ['D', ['P:B', 'A:C'], 'D'],
    ['C', ['A:A'], 'C'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/* A-B-C */
export const TEST_BASIC: TestFixture = {
  rows: [
    ['C', ['P:B'], 'C'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/*

                      T /---------------N--O---\           T
                     / /                        \           \
               /----E-F-\    /-------L--M--------P--\     S--U---\
            A-B-C-D------G--H--I--J--K---------------Q--R---------V--W
                                   \--N

*/
export const TEST_BRANCHES_AND_MERGES: TestFixture = {
  rows: [
    ['W', ['P:V'], 'W'],
    ['V', ['P:R', 'P:U'], 'V'],
    ['U', ['P:S', 'P:T'], 'U'],
    ['T', ['P:E'], 'T'],
    ['S', [], 'S'],
    ['R', ['P:Q'], 'R'],
    ['Q', ['P:K', 'P:P'], 'Q'],
    ['P', ['P:M', 'P:O'], 'P'],
    ['O', ['P:N'], 'O'],
    ['N', ['P:F', 'P:J'], 'N'],
    ['M', ['P:L'], 'M'],
    ['L', ['P:H'], 'L'],
    ['K', ['P:J'], 'K'],
    ['J', ['P:I'], 'J'],
    ['I', ['P:H'], 'I'],
    ['H', ['P:G'], 'H'],
    ['G', ['P:D', 'P:F'], 'G'],
    ['F', ['P:E'], 'F'],
    ['E', ['P:B'], 'E'],
    ['D', ['P:C'], 'D'],
    ['C', ['P:B'], 'C'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/*

                    K
                   /|
                  F J
                 / /|
                | E I
                |/ /|
                | D H
                |/ /|
                | C G
                |/ /|
                | B Z
                |/
                A

*/
export const TEST_DIFFERENT_ORDERS1: TestFixture = {
  rows: [
    ['K', ['P:F', 'P:J'], 'K'],
    ['J', ['P:E', 'P:I'], 'J'],
    ['I', ['P:D', 'P:H'], 'I'],
    ['H', ['P:C', 'P:G'], 'H'],
    ['G', ['P:B', 'P:Z'], 'G'],
    ['F', ['P:A'], 'F'],
    ['E', ['P:A'], 'E'],
    ['D', ['P:A'], 'D'],
    ['C', ['P:A'], 'C'],
    ['B', ['P:A'], 'B'],
    ['Z', [], 'Z'],
    ['A', [], 'A'],
  ],
};

export const TEST_DIFFERENT_ORDERS2: TestFixture = {
  rows: [
    ['K', ['P:F', 'P:J'], 'K'],
    ['J', ['P:E', 'P:I'], 'J'],
    ['I', ['P:D', 'P:H'], 'I'],
    ['H', ['P:C', 'P:G'], 'H'],
    ['G', ['P:B', 'P:Z'], 'G'],
    ['Z', [], 'Z'],
    ['B', ['P:A'], 'B'],
    ['C', ['P:A'], 'C'],
    ['D', ['P:A'], 'D'],
    ['E', ['P:A'], 'E'],
    ['F', ['P:A'], 'F'],
    ['A', [], 'A'],
  ],
};

export const TEST_DIFFERENT_ORDERS3: TestFixture = {
  rows: [
    ['K', ['P:F', 'P:J'], 'K'],
    ['J', ['P:A'], 'J'],
    ['F', ['P:E', 'P:I'], 'F'],
    ['I', ['P:A'], 'I'],
    ['E', ['P:D', 'P:H'], 'E'],
    ['H', ['P:A'], 'H'],
    ['D', ['P:C', 'P:G'], 'D'],
    ['G', ['P:A'], 'G'],
    ['C', ['P:B', 'P:Z'], 'C'],
    ['Z', [], 'Z'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

export const TEST_DIFFERENT_ORDERS4: TestFixture = {
  rows: [
    ['K', ['P:F', 'P:J'], 'K'],
    ['F', ['P:A'], 'F'],
    ['J', ['P:E', 'P:I'], 'J'],
    ['E', ['P:A'], 'E'],
    ['I', ['P:D', 'P:H'], 'I'],
    ['D', ['P:A'], 'D'],
    ['H', ['P:C', 'P:G'], 'H'],
    ['C', ['P:A'], 'C'],
    ['G', ['P:B', 'P:Z'], 'G'],
    ['Z', [], 'Z'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/*

                         Y-\
                  Z-A-B-D-E-F
                       \-C-/

*/
export const TEST_LONG_MESSAGES: TestFixture = {
  rows: [
    [
      'F',
      ['P:C', 'P:E', '~'],
      'F\nvery long message 1\nvery long message 2\nvery long message 3\n\nvery long message 4\nvery long message 5\nvery long message 6\n\n',
    ],
    ['E', ['P:D'], 'E'],
    ['D', ['P:B'], 'D'],
    ['C', ['P:B'], 'C\nlong message 1\nlong message 2\nlong message 3\n\n'],
    ['B', ['P:A'], 'B'],
    ['A', ['~'], 'A\nlong message 1\nlong message 2\nlong message 3\n\n'],
  ],
};

/*

                        /-----\
                       /       \
                      D /--C--\ I
                     / /---D---\ \
                    A-B----E----H-J
                       \---F---/ /
                        \--G--/ F

*/
export const TEST_OCTOPUS_BRANCH_AND_MERGE: TestFixture = {
  rows: [
    ['J', ['P:F', 'P:H', 'P:I'], 'J'],
    ['I', ['P:D'], 'I'],
    ['H', ['P:C', 'P:D', 'P:E', 'P:F', 'P:G'], 'H'],
    ['G', ['P:B'], 'G'],
    ['E', ['P:B'], 'E'],
    ['D', ['P:A', 'P:B'], 'D'],
    ['C', ['P:B'], 'C'],
    ['F', ['P:B'], 'F'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/*

                   A-B-C-F-G----\
                    D-E-/   \-W  \-X-Y-Z

*/
export const TEST_RESERVED_COLUMN: TestFixture = {
  reserve: ['G'],
  rows: [
    ['Z', ['P:Y'], 'Z'],
    ['Y', ['P:X'], 'Y'],
    ['X', ['P:G'], 'X'],
    ['W', ['P:G'], 'W'],
    ['G', ['P:F'], 'G'],
    ['F', ['P:C', 'P:E'], 'F'],
    ['E', ['P:D'], 'E'],
    ['D', [], 'D'],
    ['C', ['P:B'], 'C'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/*

                    /-B-\     A-\
                   A     D-E  B--E
                    \-C-/     C-/

*/
export const TEST_SPLIT_PARENTS: TestFixture = {
  reserve: ['B', 'D', 'C'],
  rows: [
    ['E', ['A:A', 'A:B', 'P:C', 'P:D'], 'E'],
    ['D', ['P:B', 'P:C'], 'D'],
    ['C', ['P:A'], 'C'],
    ['B', ['P:A'], 'B'],
    ['A', [], 'A'],
  ],
};

/*

                   A-B-C  D-E-\
                            F---I--J
                        X-D-H-/  \-K

*/
export const TEST_TERMINATIONS: TestFixture = {
  reserve: ['E'],
  rows: [
    ['K', ['P:I'], 'K'],
    ['J', ['P:I'], 'J'],
    ['I', ['P:E', '~', 'P:H'], 'I'],
    ['E', ['P:D'], 'E'],
    ['H', ['P:D'], 'H'],
    ['D', ['~'], 'D'],
    ['C', ['P:B'], 'C'],
    ['B', ['~'], 'B'],
  ],
};

describe('renderText', () => {
  it('renders TEST_ANCESTORS', () => {
    assertSnapshot(render(TEST_ANCESTORS), `
      "
        o  Z
        │
        o  Y
        │
      ╭─╯
      o  F
      │
      :
      │ o  X
      │ │
      ├─╯
      │ o  W
      │ │
      ├─╯
      o  E
      │
      :
      o    D
      │
      ├─╮
      │ :
      │ o  C
      │ │
      │ :
      o │  B
      │ │
      ├─╯
      o  A"
    `);
  });

  it('renders TEST_BASIC', () => {
    assertSnapshot(render(TEST_BASIC), `
      "
      o  C
      │
      o  B
      │
      o  A"
    `);
  });

  it('renders TEST_BRANCHES_AND_MERGES', () => {
    assertSnapshot(render(TEST_BRANCHES_AND_MERGES), `
      "
      o  W
      │
      o    V
      │
      ├─╮
      │ o    U
      │ │
      │ ├─╮
      │ │ o  T
      │ │ │
      │ o │  S
      │   │
      o   │  R
      │   │
      o   │  Q
      │   │
      ├─╮ │
      │ o │    P
      │ │ │
      │ ├───╮
      │ │ │ o  O
      │ │ │ │
      │ │ │ o    N
      │ │ │ │
      │ │ │ ├─╮
      │ o │ │ │  M
      │ │ │ │ │
      │ o │ │ │  L
      │ │ │ │ │
      o │ │ │ │  K
      │ │ │ │ │
      ├───────╯
      o │ │ │  J
      │ │ │ │
      o │ │ │  I
      │ │ │ │
      ├─╯ │ │
      o   │ │  H
      │   │ │
      o   │ │  G
      │   │ │
      ├─────╮
      │   │ o  F
      │   │ │
      │   ├─╯
      │   o  E
      │   │
      o   │  D
      │   │
      o   │  C
      │   │
      ├───╯
      o  B
      │
      o  A"
    `);
  });

  it('renders TEST_DIFFERENT_ORDERS1', () => {
    assertSnapshot(render(TEST_DIFFERENT_ORDERS1), `
      "
      o    K
      │
      ├─╮
      │ o    J
      │ │
      │ ├─╮
      │ │ o    I
      │ │ │
      │ │ ├─╮
      │ │ │ o    H
      │ │ │ │
      │ │ │ ├─╮
      │ │ │ │ o    G
      │ │ │ │ │
      │ │ │ │ ├─╮
      o │ │ │ │ │  F
      │ │ │ │ │ │
      │ o │ │ │ │  E
      │ │ │ │ │ │
      ├─╯ │ │ │ │
      │   o │ │ │  D
      │   │ │ │ │
      ├───╯ │ │ │
      │     o │ │  C
      │     │ │ │
      ├─────╯ │ │
      │       o │  B
      │       │ │
      ├───────╯ │
      │         o  Z
      │
      o  A"
    `);
  });

  it('renders TEST_DIFFERENT_ORDERS2', () => {
    assertSnapshot(render(TEST_DIFFERENT_ORDERS2), `
      "
      o    K
      │
      ├─╮
      │ o    J
      │ │
      │ ├─╮
      │ │ o    I
      │ │ │
      │ │ ├─╮
      │ │ │ o    H
      │ │ │ │
      │ │ │ ├─╮
      │ │ │ │ o    G
      │ │ │ │ │
      │ │ │ │ ├─╮
      │ │ │ │ │ o  Z
      │ │ │ │ │
      │ │ │ │ o  B
      │ │ │ │ │
      │ │ │ o │  C
      │ │ │ │ │
      │ │ │ ├─╯
      │ │ o │  D
      │ │ │ │
      │ │ ├─╯
      │ o │  E
      │ │ │
      │ ├─╯
      o │  F
      │ │
      ├─╯
      o  A"
    `);
  });

  it('renders TEST_DIFFERENT_ORDERS3', () => {
    assertSnapshot(render(TEST_DIFFERENT_ORDERS3), `
      "
      o    K
      │
      ├─╮
      │ o  J
      │ │
      o │    F
      │ │
      ├───╮
      │ │ o  I
      │ │ │
      │ ├─╯
      o │    E
      │ │
      ├───╮
      │ │ o  H
      │ │ │
      │ ├─╯
      o │    D
      │ │
      ├───╮
      │ │ o  G
      │ │ │
      │ ├─╯
      o │    C
      │ │
      ├───╮
      │ │ o  Z
      │ │
      o │  B
      │ │
      ├─╯
      o  A"
    `);
  });

  it('renders TEST_DIFFERENT_ORDERS4', () => {
    assertSnapshot(render(TEST_DIFFERENT_ORDERS4), `
      "
      o    K
      │
      ├─╮
      o │  F
      │ │
      │ o    J
      │ │
      │ ├─╮
      │ o │  E
      │ │ │
      ├─╯ │
      │   o  I
      │   │
      │ ╭─┤
      │ │ o  D
      │ │ │
      ├───╯
      │ o    H
      │ │
      │ ├─╮
      │ o │  C
      │ │ │
      ├─╯ │
      │   o  G
      │   │
      │ ╭─┤
      │ o │  Z
      │   │
      │   o  B
      │   │
      ├───╯
      o  A"
    `);
    assertSnapshot(render(TEST_DIFFERENT_ORDERS4, true), `
      "
      o    K
      │    # top pad
      ├─╮  # link line
      │ │  # pad line
      --------------------
      o    F
      │    # top pad
      │    # pad line
      --------------------
        o    J
        │    # top pad
        ├─╮  # link line
        │ │  # pad line
      --------------------
        o    E
        │    # top pad
      ╭─╯    # link line
      │      # pad line
      --------------------
          o  I
          │  # top pad
        ╭─┤  # link line
        │ │  # pad line
      --------------------
          o  D
          │  # top pad
      ╭───╯  # link line
      │      # pad line
      --------------------
        o    H
        │    # top pad
        ├─╮  # link line
        │ │  # pad line
      --------------------
        o    C
        │    # top pad
      ╭─╯    # link line
      │      # pad line
      --------------------
          o  G
          │  # top pad
        ╭─┤  # link line
        │ │  # pad line
      --------------------
        o    Z
             # top pad
             # pad line
      --------------------
          o  B
          │  # top pad
      ╭───╯  # link line
      │      # pad line
      --------------------
      o  A
         # top pad
         # pad line
      --------------------"
    `);
  });

  it('renders TEST_LONG_MESSAGES', () => {
    assertSnapshot(render(TEST_LONG_MESSAGES), `
      "
      o      F
      │      very long message 1
      ├─┬─╮  very long message 2
      │ │ │  very long message 3
      │ │ ~
      │ │    very long message 4
      │ │    very long message 5
      │ │    very long message 6
      │ │
      │ o  E
      │ │
      │ o  D
      │ │
      o │  C
      │ │  long message 1
      ├─╯  long message 2
      │    long message 3
      │
      o  B
      │
      o  A
      │  long message 1
      │  long message 2
      ~  long message 3"
    `);
  });

  it('renders TEST_OCTOPUS_BRANCH_AND_MERGE', () => {
    assertSnapshot(render(TEST_OCTOPUS_BRANCH_AND_MERGE), `
      "
      o      J
      │
      ├─┬─╮
      │ │ o  I
      │ │ │
      │ o │      H
      │ │ │
      ╭─┼─┬─┬─╮
      │ │ │ │ o  G
      │ │ │ │ │
      │ │ │ o │  E
      │ │ │ │ │
      │ │ │ ├─╯
      │ │ o │  D
      │ │ │ │
      │ │ ├─╮
      │ o │ │  C
      │ │ │ │
      │ ├───╯
      o │ │  F
      │ │ │
      ├─╯ │
      o   │  B
      │   │
      ├───╯
      o  A"
    `);
  });

  it('renders TEST_RESERVED_COLUMN', () => {
    assertSnapshot(render(TEST_RESERVED_COLUMN), `
      "
        o  Z
        │
        o  Y
        │
        o  X
        │
      ╭─╯
      │ o  W
      │ │
      ├─╯
      o  G
      │
      o    F
      │
      ├─╮
      │ o  E
      │ │
      │ o  D
      │
      o  C
      │
      o  B
      │
      o  A"
    `);
  });

  it('renders TEST_SPLIT_PARENTS', () => {
    assertSnapshot(render(TEST_SPLIT_PARENTS), `
      "
            o  E
            │
      ╭─┬─┬─┤
      : │ │ :
      │ o │ │  D
      │ │ │ │
      ╭─┴─╮ │
      │   o │  C
      │   │ │
      │   ├─╯
      o   │  B
      │   │
      ├───╯
      o  A"
    `);
    assertSnapshot(render(TEST_SPLIT_PARENTS, true), `
      "
            o  E
            │  # top pad
      ╭─┬─┬─┤  # link line
      : │ │ :  # pad line
      --------------------
        o      D
        │      # top pad
      ╭─┴─╮    # link line
      │   │    # pad line
      --------------------
          o    C
          │    # top pad
          │    # link line
          │    # pad line
      --------------------
      o      B
      │      # top pad
      │      # link line
      │      # pad line
      --------------------
      o  A
         # top pad
         # pad line
      --------------------"
    `);
  });

  it('renders TEST_TERMINATIONS', () => {
    assertSnapshot(render(TEST_TERMINATIONS), `
      "
        o  K
        │
        │ o  J
        │ │
        ├─╯
        o    I
        │
      ╭─┼─╮
      │ │ │
      │ ~ │
      │   │
      o   │  E
      │   │
      │   o  H
      │   │
      ├───╯
      o  D
      │
      │
      ~

      o  C
      │
      o  B
      │
      │
      ~"
    `);
  });
});

function render(fixture: TestFixture, debugLinkLineFromNode = false): string {
  const {rows, reserve} = fixture;
  const renderer = new TextRenderer({debugLinkLineFromNode});
  if (reserve != null) {
    for (const h of reserve) {
      renderer.reserve(h);
    }
  }
  const rendered = rows.map(([hash, parents, message]) => {
    // Convert parents from string to Ancestor[]
    const ancestors = parents.map(p => {
      if (p.startsWith('P:')) {
        return new Ancestor({hash: p.substring(2), type: AncestorType.Parent});
      } else if (p.startsWith('A:')) {
        return new Ancestor({hash: p.substring(2), type: AncestorType.Ancestor});
      } else {
        return new Ancestor({hash: undefined, type: AncestorType.Anonymous});
      }
    });
    return renderer.nextRow(hash, ancestors, message.trimEnd() + '\n');
  });
  return '\n' + rendered.join('').trimEnd();
}

/**
 * Jest's `toMatchInlineSnapshot` for a string value: the expectation is the serialised value —
 * the string in double quotes — re-indented to sit under the call site. Undo both, then compare.
 * This is the only thing the upstream file needed that `node:assert` does not have.
 */
function assertSnapshot(actual: string, snapshot: string): void {
  const lines = snapshot.split('\n');
  // Line 0 is empty (the newline after the backtick) and the last line is the indentation before
  // the closing backtick; every line between them carries the indentation of the first of them.
  const indentation = /^[^\S\n]*/.exec(lines[1])?.[0] ?? '';
  const serialized = lines
    .slice(1, -1)
    .map(line => (line.startsWith(indentation) ? line.slice(indentation.length) : line))
    .join('\n');
  // Strip the serialiser's quotes.
  assert.equal(actual, serialized.slice(1, -1));
}
