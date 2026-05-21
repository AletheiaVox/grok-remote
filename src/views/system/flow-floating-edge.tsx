// Floating-edge support for the live agent Flow canvas.
//
// React Flow's default edges anchor to a fixed Handle on each node, so when
// dagre lays nodes out in arbitrary positions an edge will often crawl across
// the body of its target to reach the chosen handle. The "floating edge"
// pattern (recommended in the React Flow docs at
// https://reactflow.dev/examples/edges/floating-edges) instead computes the
// edge endpoint as the closest intersection point on each node's bounding
// rectangle every render, so the edge always touches the nearest side.

import React from 'react';
import { BaseEdge, useInternalNode, getStraightPath } from '@xyflow/react';

interface NodeLike {
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  position?: { x: number; y: number };
  internals?: { positionAbsolute?: { x: number; y: number } };
}

interface Point { x: number; y: number }
interface EdgeParams { sx: number; sy: number; tx: number; ty: number }

interface FloatingEdgeData {
  color?: string;
  strokeWidth?: number;
  strokeDasharray?: string | number;
}

interface FloatingEdgeProps {
  id: string;
  source: string;
  target: string;
  markerEnd?: string;
  markerStart?: string;
  style?: React.CSSProperties;
  data?: FloatingEdgeData;
  animated?: boolean;
  selected?: boolean;
}

function nodeCenter(node: NodeLike): Point {
  const w = (node.measured && node.measured.width)  || node.width  || 0;
  const h = (node.measured && node.measured.height) || node.height || 0;
  const pos = (node.internals && node.internals.positionAbsolute) || node.position || { x: 0, y: 0 };
  return { x: pos.x + w / 2, y: pos.y + h / 2 };
}

function getIntersectionPoint(node: NodeLike, otherCenter: Point): Point {
  const w = (node.measured && node.measured.width)  || node.width  || 1;
  const h = (node.measured && node.measured.height) || node.height || 1;
  const pos = (node.internals && node.internals.positionAbsolute) || node.position || { x: 0, y: 0 };
  const cx = pos.x + w / 2;
  const cy = pos.y + h / 2;
  const dx = otherCenter.x - cx;
  const dy = otherCenter.y - cy;

  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const hw = w / 2;
  const hh = h / 2;

  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);

  return { x: cx + dx * t, y: cy + dy * t };
}

export function getEdgeParams(source: NodeLike, target: NodeLike): EdgeParams {
  const sc = nodeCenter(source);
  const tc = nodeCenter(target);
  const sIntersect = getIntersectionPoint(source, tc);
  const tIntersect = getIntersectionPoint(target, sc);
  return {
    sx: sIntersect.x,
    sy: sIntersect.y,
    tx: tIntersect.x,
    ty: tIntersect.y,
  };
}

export function FloatingEdge({
  id,
  source,
  target,
  markerEnd,
  markerStart,
  style,
  data,
  animated,
  selected,
}: FloatingEdgeProps): React.ReactElement | null {
  void animated;
  void selected;
  const sourceNode = useInternalNode(source) as NodeLike | undefined;
  const targetNode = useInternalNode(target) as NodeLike | undefined;

  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode);
  const [edgePath] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });

  const color  = (data && data.color)       || (style && (style.stroke as string))         || 'var(--teal)';
  const width  = (data && data.strokeWidth) || (style && (style.strokeWidth as number))    || 1.2;
  const op     = (style && style.opacity != null) ? style.opacity : 1;
  const dash   = (style && (style.strokeDasharray as string | number | undefined)) || (data && data.strokeDasharray) || undefined;

  const mergedStyle: React.CSSProperties = {
    ...(style || {}),
    stroke: color,
    strokeWidth: width,
    opacity: op,
    strokeDasharray: dash,
  };

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      style={mergedStyle}
    />
  );
}

export default FloatingEdge;
