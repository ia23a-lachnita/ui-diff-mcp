export interface PixelComponent {
  box: { x: number; y: number; width: number; height: number };
  pixelCount: number;
}

interface ClusterNode {
  parent: number;
  rank: number;
  box: { x: number; y: number; width: number; height: number };
}

function find(nodes: ClusterNode[], i: number): number {
  if (nodes[i]!.parent !== i) nodes[i]!.parent = find(nodes, nodes[i]!.parent);
  return nodes[i]!.parent;
}

function union(nodes: ClusterNode[], a: number, b: number): void {
  const ra = find(nodes, a);
  const rb = find(nodes, b);
  if (ra === rb) return;

  const boxA = nodes[ra]!.box;
  const boxB = nodes[rb]!.box;
  const mergedX = Math.min(boxA.x, boxB.x);
  const mergedY = Math.min(boxA.y, boxB.y);
  const mergedW = Math.max(boxA.x + boxA.width, boxB.x + boxB.width) - mergedX;
  const mergedH = Math.max(boxA.y + boxA.height, boxB.y + boxB.height) - mergedY;
  const mergedBox = { x: mergedX, y: mergedY, width: mergedW, height: mergedH };

  if (nodes[ra]!.rank < nodes[rb]!.rank) {
    nodes[ra]!.parent = rb;
    nodes[rb]!.box = mergedBox;
  } else if (nodes[ra]!.rank > nodes[rb]!.rank) {
    nodes[rb]!.parent = ra;
    nodes[ra]!.box = mergedBox;
  } else {
    nodes[rb]!.parent = ra;
    nodes[ra]!.rank++;
    nodes[ra]!.box = mergedBox;
  }
}

function overlapsExpanded(a: PixelComponent["box"], b: PixelComponent["box"], gap: number): boolean {
  return (
    a.x - gap < b.x + b.width &&
    a.x + a.width + gap > b.x &&
    a.y - gap < b.y + b.height &&
    a.y + a.height + gap > b.y
  );
}

export function clusterUncoveredComponents(
  components: PixelComponent[],
  options: { maxGapPx: number; maxClusterAreaRatio: number; imageWidth: number; imageHeight: number }
): PixelComponent[] {
  if (components.length === 0) return [];

  const screenArea = options.imageWidth * options.imageHeight;

  const nodes: ClusterNode[] = components.map((c, i) => ({ parent: i, rank: 0, box: c.box }));

  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (overlapsExpanded(components[i]!.box, components[j]!.box, options.maxGapPx)) {
        const ri = find(nodes, i);
        const rj = find(nodes, j);
        if (ri === rj) continue;

        const clusterBoxI = nodes[ri]!.box;
        const clusterBoxJ = nodes[rj]!.box;
        const mergedX = Math.min(clusterBoxI.x, clusterBoxJ.x);
        const mergedY = Math.min(clusterBoxI.y, clusterBoxJ.y);
        const mergedW = Math.max(clusterBoxI.x + clusterBoxI.width, clusterBoxJ.x + clusterBoxJ.width) - mergedX;
        const mergedH = Math.max(clusterBoxI.y + clusterBoxI.height, clusterBoxJ.y + clusterBoxJ.height) - mergedY;
        const mergedArea = mergedW * mergedH;

        if (screenArea > 0 && mergedArea / screenArea >= options.maxClusterAreaRatio) continue;

        union(nodes, i, j);
      }
    }
  }

  const clusters = new Map<number, PixelComponent[]>();
  for (let i = 0; i < components.length; i++) {
    const root = find(nodes, i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(components[i]!);
  }

  return [...clusters.values()].map(members => {
    const xs = members.flatMap(m => [m.box.x, m.box.x + m.box.width]);
    const ys = members.flatMap(m => [m.box.y, m.box.y + m.box.height]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    const pixelCount = members.reduce((s, m) => s + m.pixelCount, 0);
    return { box: { x, y, width, height }, pixelCount };
  });
}
