import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(value.snapshot && Number.isInteger(value.budget) && value.requestsUsed <= value.budget);
  const identifiers = value.records.map(record => record.id);
  assert.equal(new Set(identifiers).size, identifiers.length);
  function visit(node) {
    assert.equal(node.snapshot, value.snapshot);
    const children = node.children || [];
    const complete = children.length ? children.map(visit).every(Boolean) : node.status === 'complete' && node.evidence?.truncated === false;
    if (node.status === 'complete') assert.ok(complete, '完成节点缺少未截断覆盖证据');
    return complete;
  }
  const proven = visit(value.tree);
  if (value.complete) assert.ok(proven);
}
