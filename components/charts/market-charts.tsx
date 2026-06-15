"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ChartPoint } from "@/lib/types";
import { formatUsd } from "@/lib/utils";

export function ProbabilityChart({ data }: { data: ChartPoint[] }) {
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 0, right: 16, top: 16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#dbe3ee" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#64748b" />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(value) => `${Math.round(Number(value) * 100)}%`}
            tick={{ fontSize: 12 }}
            stroke="#64748b"
          />
          <Tooltip
            formatter={(value) => [`${Math.round(Number(value) * 100)}%`, "確率"]}
            labelClassName="font-semibold"
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#183a6b"
            strokeWidth={2.5}
            dot={{ r: 2 }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function VolumeChart({ data }: { data: ChartPoint[] }) {
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 16, top: 16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#dbe3ee" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#64748b" />
          <YAxis tickFormatter={(value) => formatUsd(Number(value))} tick={{ fontSize: 12 }} stroke="#64748b" />
          <Tooltip formatter={(value) => [formatUsd(Number(value)), "出来高"]} labelClassName="font-semibold" />
          <Bar dataKey="value" fill="#2f6f8f" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
