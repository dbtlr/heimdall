import { describe, expect, test } from 'bun:test';

import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Area } from 'recharts';

import type { ChartView } from '../lib/condition-detail.ts';
import { ConditionChart } from './condition-chart.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { MemoryPlot } from './memory-plot.tsx';
import { PlotGradient } from './plot-scale.tsx';
import { ProcessPlot } from './process-plot.tsx';

const GIB = 1024 ** 3;
const WINDOW = { from: 0, to: 600_000 };

// What a plot component returns, before React renders it: Recharts draws its
// layers only in a browser, so a test reads them from this tree instead.
const treeOf = <Props,>(plot: (props: Props) => ReactNode, props: Props): ReactNode => {
  let tree: ReactNode = null;
  function Capture() {
    tree = plot(props);
    return null;
  }
  renderToStaticMarkup(<Capture />);
  return tree;
};

type LayerProps = { children?: ReactNode; fill?: string; id?: string };

// Every element in the tree, through each element's children.
const elementsOf = (node: ReactNode): ReactElement<LayerProps>[] => {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<LayerProps>(node)) {
    return [];
  }
  return [node, ...elementsOf(node.props.children)];
};

// The gradient ids a plot defines, and the fills of its Recharts areas.
const fillsOf = (tree: ReactNode) => {
  const elements = elementsOf(tree);
  return {
    areas: elements.filter((element) => element.type === Area).map((element) => element.props.fill),
    gradients: elements
      .filter((element) => element.type === PlotGradient)
      .map((element) => `url(#${element.props.id ?? ''})`),
  };
};

// Each scale label as its position's value and the text it shows.
const ticksOf = (html: string) =>
  [...html.matchAll(/data-scale-tick="([^"]*)" style="top:([^"]*)%">([^<]*)</gu)].map(
    ([, value, top, text]) => ({ text, top: Number(top), value: Number(value) }),
  );

// A label states the value drawn at its position.
const expectHonest = (ticks: ReturnType<typeof ticksOf>) => {
  for (const { text, value } of ticks) {
    expect(Number.parseFloat(text ?? '')).toBe(value);
  }
};

describe('CpuPlot', () => {
  const props = {
    buckets: [
      { average: 10, high: 20, low: 5, t: 0 },
      { average: 20, high: 30, low: 10, t: 300_000 },
    ],
    label: 'CPU busy',
    window: WINDOW,
  };

  test('fills the area under its average with its gradient', () => {
    const { areas, gradients } = fillsOf(treeOf(CpuPlot, props));
    expect(gradients).toHaveLength(1);
    expect(areas).toContain(gradients[0]);
  });

  test('labels 100, 50, and 0 at the top, middle, and bottom', () => {
    const ticks = ticksOf(renderToStaticMarkup(treeOf(CpuPlot, props)));
    expect(ticks).toEqual([
      { text: '100', top: 0, value: 100 },
      { text: '50', top: 50, value: 50 },
      { text: '0', top: 100, value: 0 },
    ]);
  });
});

describe('MemoryPlot', () => {
  const buckets = [
    { t: 0, totalBytes: 31.3 * GIB, usedBytes: 12 * GIB },
    { t: 300_000, totalBytes: 31.3 * GIB, usedBytes: 14 * GIB },
  ];

  test('fills the area under memory used with its gradient', () => {
    const { areas, gradients } = fillsOf(treeOf(MemoryPlot, { buckets, window: WINDOW }));
    expect(gradients).toHaveLength(1);
    expect(areas).toContain(gradients[0]);
  });

  test('scales to a whole number of GiB above the memory, and each label states its position', () => {
    const ticks = ticksOf(renderToStaticMarkup(treeOf(MemoryPlot, { buckets, window: WINDOW })));
    expect(ticks.map(({ text }) => text)).toEqual(['32 GiB', '16', '0']);
    expectHonest(ticks);
  });

  test('states no scale for a System with no memory reported', () => {
    const html = renderToStaticMarkup(treeOf(MemoryPlot, { buckets: [], window: WINDOW }));
    expect(html).not.toContain('data-scale-tick');
  });
});

// A Harness process with one reading per 5-minute bucket.
const harnessProcess = (processId: number, cores: (number | null)[]) => ({
  harness: processId === 1 ? 'claude-code' : 'codex',
  pid: 100 + processId,
  points: cores.map((value, index) => ({ cores: value, t: index * 300_000 })),
  processId,
  project: undefined,
});

describe('ProcessPlot', () => {
  test('fills under each process with a gradient of its own', () => {
    const { areas, gradients } = fillsOf(
      treeOf(ProcessPlot, {
        processes: [harnessProcess(1, [0.2, 0.4]), harnessProcess(2, [1.37, 0.3])],
        window: WINDOW,
      }),
    );
    expect(areas).toHaveLength(2);
    expect(new Set(areas)).toEqual(new Set(gradients));
  });

  test('scales to a tenth of a core above the busiest, and each label states its position', () => {
    const processes = [harnessProcess(1, [1.37, 0.3])];
    const ticks = ticksOf(renderToStaticMarkup(treeOf(ProcessPlot, { processes, window: WINDOW })));
    expect(ticks.map(({ text }) => text)).toEqual(['1.4 cores', '0.7', '0']);
    expectHonest(ticks);
  });

  test('states no scale when no process kept a core busy in the window', () => {
    const html = renderToStaticMarkup(
      treeOf(ProcessPlot, { processes: [harnessProcess(1, [null, null])], window: WINDOW }),
    );
    expect(html).not.toContain('data-scale-tick');
  });
});

describe('ConditionChart', () => {
  const chart: ChartView = {
    captions: { left: 'node', right: '0 to 1.3 cores, limit 0.5 core', rule: undefined },
    domain: [0, 1.3],
    label: 'node CPU cores',
    lines: [{ label: '0.5 core', level: 'warning', value: 0.5 }],
    points: [
      { t: 0, value: 0.2 },
      { t: 300_000, value: 0.86 },
    ],
    window: WINDOW,
  };

  test('fills the area under the reading with its gradient', () => {
    const { areas, gradients } = fillsOf(treeOf(ConditionChart, { chart }));
    expect(gradients).toHaveLength(1);
    expect(areas).toContain(gradients[0]);
  });

  test('draws each limit as a dashed line at its value, in its level colour', () => {
    const html = renderToStaticMarkup(treeOf(ConditionChart, { chart }));
    expect(html).toMatch(
      /class="[^"]*border-dashed[^"]*" data-limit="0.5" style="border-color:var\(--status-serious\);top:61\.53\d*%"/u,
    );
    expect(html).toContain('0.5 core');
  });

  test('labels its own scale, each label stating its position', () => {
    const ticks = ticksOf(renderToStaticMarkup(treeOf(ConditionChart, { chart })));
    expect(ticks.map(({ text }) => text)).toEqual(['1.3', '0.65', '0']);
    expectHonest(ticks);
  });
});
