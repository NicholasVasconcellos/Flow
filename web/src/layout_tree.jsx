// Layout tree primitives — a recursive split tree for fully-draggable panes.
//
// Node shapes:
//   { type: 'leaf', id }
//   { type: 'split', dir: 'row'|'col', sizes: number[], children: Node[] }
//
// `dir`:
//   'row' = children laid out left-to-right (a horizontal row of children)
//   'col' = children laid out top-to-bottom (a vertical stack)
// `sizes` is parallel to `children`; values are flex weights that sum is irrelevant
// (we treat them as proportional). Default to 1 each on insert.
//
// Edges (for drop targets):
//   'left'   → insert dragged BEFORE target as a row sibling
//   'right'  → insert dragged AFTER  target as a row sibling
//   'top'    → insert dragged BEFORE target as a col sibling
//   'bottom' → insert dragged AFTER  target as a col sibling

const LEAF_IDS = ["dag", "sessions", "details"];

function leaf(id) { return { type: "leaf", id }; }
function split(dir, children, sizes) {
  return { type: "split", dir, children, sizes: sizes || children.map(() => 1) };
}

// Default tree: rows direction = stacked top-to-bottom = a 'col' split.
function defaultTree() {
  return split("col", [leaf("dag"), leaf("sessions"), leaf("details")], [1.6, 1.0, 0.9]);
}

function flattenTreeToCol(ids) {
  return split("col", ids.map(leaf), ids.map(() => 1));
}
function flattenTreeToRow(ids) {
  return split("row", ids.map(leaf), ids.map(() => 1));
}

// Walk the tree and collect every leaf id in document order.
function collectLeafIds(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.type === "leaf") { out.push(node.id); return out; }
  for (const c of node.children) collectLeafIds(c, out);
  return out;
}

// Validate a tree contains exactly the expected leaf set, no dups.
function validateTree(node) {
  if (!node) return false;
  const ids = collectLeafIds(node);
  if (ids.length !== LEAF_IDS.length) return false;
  const seen = new Set();
  for (const id of ids) {
    if (!LEAF_IDS.includes(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

// Deep clone (structuredClone is fine for our shape but be safe across browsers).
function cloneTree(n) {
  if (n.type === "leaf") return { type: "leaf", id: n.id };
  return { type: "split", dir: n.dir, sizes: n.sizes.slice(), children: n.children.map(cloneTree) };
}

// Remove the leaf with the given id. Returns the new tree (may be null if root
// was that single leaf — shouldn't happen with 3 panes, but be defensive).
// Compaction rules:
//   - If a split ends with 1 child, replace it with its child.
//   - If a split has 0 children, return null up the chain (caller compacts).
function removeLeaf(node, id) {
  if (!node) return null;
  if (node.type === "leaf") return node.id === id ? null : node;
  const newChildren = [];
  const newSizes = [];
  node.children.forEach((c, i) => {
    const r = removeLeaf(c, id);
    if (r) { newChildren.push(r); newSizes.push(node.sizes[i]); }
  });
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0]; // collapse single-child split
  return { type: "split", dir: node.dir, children: newChildren, sizes: newSizes };
}

// Find the path (array of child indices) to the leaf with id `id`.
function findLeafPath(node, id, path) {
  path = path || [];
  if (node.type === "leaf") return node.id === id ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const r = findLeafPath(node.children[i], id, path.concat(i));
    if (r) return r;
  }
  return null;
}

// Get node at path.
function getAtPath(root, path) {
  let n = root;
  for (const i of path) n = n.children[i];
  return n;
}

// Replace the node at path with `replacement`, returning a new tree.
function replaceAtPath(root, path, replacement) {
  if (path.length === 0) return replacement;
  const cloned = cloneTree(root);
  let parent = cloned;
  for (let i = 0; i < path.length - 1; i++) parent = parent.children[path[i]];
  parent.children[path[path.length - 1]] = replacement;
  return cloned;
}

// Insert `draggedId` adjacent to leaf `targetId` on the given edge.
// Returns a new tree.
function insertAdjacent(root, targetId, edge, draggedId) {
  // 1. Remove dragged leaf from a clone of the tree.
  let stripped = removeLeaf(root, draggedId);
  if (!stripped) stripped = root; // safety
  // After removal, find the target leaf's path in the stripped tree.
  const targetPath = findLeafPath(stripped, targetId);
  if (!targetPath) return root; // target gone? bail
  const targetLeaf = getAtPath(stripped, targetPath);

  const wantDir = (edge === "left" || edge === "right") ? "row" : "col";
  const before = (edge === "left" || edge === "top");
  const dragged = leaf(draggedId);

  // OPTIMIZATION: if the target's parent is a split in the same direction,
  // insert dragged as a sibling of the target inside that parent (don't
  // create a new nested split). This keeps the tree flat.
  if (targetPath.length > 0) {
    const parentPath = targetPath.slice(0, -1);
    const indexInParent = targetPath[targetPath.length - 1];
    const parent = getAtPath(stripped, parentPath);
    if (parent.type === "split" && parent.dir === wantDir) {
      const insertAt = before ? indexInParent : indexInParent + 1;
      // Splice dragged into a clone of the parent; carry over sizes (give new child same size as target).
      const targetSize = parent.sizes[indexInParent] ?? 1;
      const newChildren = parent.children.slice();
      const newSizes = parent.sizes.slice();
      // Halve the target's size and give the same to the new sibling so the
      // parent's overall size stays stable.
      const half = targetSize / 2;
      newSizes[indexInParent] = half;
      newChildren.splice(insertAt, 0, dragged);
      newSizes.splice(insertAt, 0, half);
      const newParent = { type: "split", dir: parent.dir, children: newChildren, sizes: newSizes };
      return replaceAtPath(stripped, parentPath, newParent);
    }
  }

  // Otherwise wrap target leaf in a new split with dragged as sibling.
  const newChildren = before ? [dragged, targetLeaf] : [targetLeaf, dragged];
  const newSplit = { type: "split", dir: wantDir, children: newChildren, sizes: [1, 1] };
  return replaceAtPath(stripped, targetPath, newSplit);
}

export {
  LEAF_IDS,
  defaultTree,
  flattenTreeToCol,
  flattenTreeToRow,
  collectLeafIds,
  validateTree,
  cloneTree,
  removeLeaf,
  findLeafPath,
  insertAdjacent,
};
