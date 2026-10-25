'use client';
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export interface DueBar {
  name: string;
  days: number;
  paid: boolean;
}

export function DueChart({ rows }: { rows: DueBar[] }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const fp = rows.map(r => `${r.name}:${r.days}:${r.paid ? 1 : 0}`).join('|');

  const ready = rows.length > 0;
  useEffect(() => {
    if (!ready || !el.current) return;
    if (!chart.current) chart.current = echarts.init(el.current, undefined, { renderer: 'canvas' });
    const onResize = () => chart.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, [ready]);

  useEffect(() => {
    if (!chart.current || rows.length === 0) return;
    const color = (r: DueBar) => {
      if (r.paid) return '#1f6b4a';
      if (r.days < 0) return '#9e3524';
      if (r.days <= 14) return '#c4a15a';
      return '#141414';
    };
    chart.current.setOption({
      animation: false,
      grid: { left: 88, right: 28, top: 8, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (p: unknown) => {
          const item = Array.isArray(p) ? p[0] as { dataIndex: number } : p as { dataIndex: number };
          const r = rows[item.dataIndex];
          if (!r) return '';
          if (r.paid) return `${r.name}: paid`;
          if (r.days < 0) return `${r.name}: ${-r.days} days late`;
          if (r.days === 0) return `${r.name}: due today`;
          return `${r.name}: ${r.days} days left`;
        },
      },
      xAxis: {
        type: 'value',
        name: 'Days left',
        nameTextStyle: { color: '#8a8a8a', fontSize: 11 },
        axisLabel: { color: '#8a8a8a' },
        splitLine: { lineStyle: { color: '#eceee9' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map(r => r.name),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: '#5c5c5c', fontSize: 12 },
      },
      series: [{
        type: 'bar',
        barWidth: 14,
        data: rows.map(r => ({
          value: r.days,
          itemStyle: { color: color(r), borderRadius: 8 },
        })),
      }],
    });
  }, [fp, rows]);

  if (rows.length === 0) return null;
  return <div ref={el} className="due-chart" role="img" aria-label="Days left to clear each bill" />;
}
