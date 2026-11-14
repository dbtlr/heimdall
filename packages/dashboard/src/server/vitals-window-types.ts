// The System's Vitals around a moment, as a chart reads them: the Service page
// draws them around a stop, and a Condition page around the Condition. Times are
// epoch milliseconds.

// One reading: busy CPU and used memory in percent, and the 1-minute load
// average. A value is null when the reading had none.
export type VitalsPoint = {
  cpu: number | null;
  load: number | null;
  memory: number | null;
  t: number;
};

export type VitalsWindow = {
  from: number;
  // The limits the Hub judges by now. Undefined when it stores none, and for
  // memory on a macOS System, which the Hub judges by kernel pressure.
  limits: { cpuPercent: number | undefined; memoryPercent: number | undefined };
  points: VitalsPoint[];
  // Raw samples, or the 5-minute rollups once the window is older than the
  // raw samples are kept or too long to read raw.
  source: 'rollups' | 'samples';
  to: number;
};
