// Validates task-map data (format version 1). Loaded two ways, so it stays a plain script:
// the page includes it with <script>, and bin/validate.mjs requires it from Node.
// Every rule here is documented in docs/data-format.md; keep the two in step.
(function (root) {
  'use strict';

  var VERSION = 1;
  var KINDS = ['milestone', 'gate', 'task', 'issue'];
  var SPINE_KINDS = ['milestone', 'gate'];
  var STATUSES = ['done', 'todo', 'next', 'progress', 'gate', 'review', 'failed', 'blocked', 'open'];
  var EDGE_TYPES = ['dep', 'gate', 'advisory', 'resolves'];
  var TOP_KEYS = ['version', 'title', 'source', 'generatedAt', 'kindNames', 'nodes', 'edges'];
  var NODE_KEYS = ['id', 'kind', 'label', 'title', 'status', 'parent', 'url', 'urlLabel', 'detail', 'queued',
    'optional', 'tags', 'progress', 'links', 'sections'];
  var EDGE_KEYS = ['from', 'to', 'type'];
  // Keys an adapter reaches for by habit, and the field that means what it wanted.
  var DID_YOU_MEAN = { labels: 'tags', children: 'parent (set on each child)', state: 'status', name: 'title',
    description: 'sections', dependsOn: 'dep edges', depends_on: 'dep edges', blockedBy: 'dep edges', type: 'kind' };

  function unknownKeys(value, allowed, at, error) {
    Object.keys(value).forEach(function (key) {
      if (allowed.indexOf(key) !== -1) return;
      var hint = DID_YOU_MEAN[key] ? '; did you mean ' + DID_YOU_MEAN[key] + '?' : '';
      error(at + '.' + key, 'is not a field in format version ' + VERSION + hint);
    });
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  function isCount(value) {
    return Number.isInteger(value) && value >= 0;
  }

  function validate(data) {
    var errors = [];
    var warnings = [];
    function error(path, message) { errors.push({ path: path, message: message }); }
    function warn(path, message) { warnings.push({ path: path, message: message }); }

    if (!isObject(data)) {
      error('$', 'must be an object with version, title, nodes, and edges');
      return { errors: errors, warnings: warnings };
    }
    if (data.version !== VERSION) error('$.version', 'must be ' + VERSION);
    unknownKeys(data, TOP_KEYS, '$', error);
    if (!isNonEmptyString(data.title)) error('$.title', 'must be a non-empty string');
    ['source', 'generatedAt'].forEach(function (key) {
      if (data[key] !== undefined && typeof data[key] !== 'string') error('$.' + key, 'must be a string when present');
    });
    if (data.kindNames !== undefined) {
      if (!isObject(data.kindNames)) error('$.kindNames', 'must be an object when present');
      else Object.keys(data.kindNames).forEach(function (key) {
        if (KINDS.indexOf(key) === -1) error('$.kindNames.' + key, 'is not a kind; use one of ' + KINDS.join(', '));
        else if (!isNonEmptyString(data.kindNames[key])) error('$.kindNames.' + key, 'must be a non-empty string');
      });
    }
    if (!Array.isArray(data.nodes)) error('$.nodes', 'must be an array');
    if (!Array.isArray(data.edges)) error('$.edges', 'must be an array (use [] when there are none)');
    if (errors.length) return { errors: errors, warnings: warnings };

    var byId = {};
    data.nodes.forEach(function (node, i) {
      var at = '$.nodes[' + i + ']';
      if (!isObject(node)) { error(at, 'must be an object'); return; }
      if (!isNonEmptyString(node.id)) { error(at + '.id', 'must be a non-empty string'); return; }
      at = '$.nodes[' + i + '] (' + node.id + ')';
      unknownKeys(node, NODE_KEYS, at, error);
      if (byId[node.id]) error(at + '.id', 'duplicates another node; ids must be unique');
      byId[node.id] = node;
      if (KINDS.indexOf(node.kind) === -1) error(at + '.kind', 'must be one of ' + KINDS.join(', '));
      if (!isNonEmptyString(node.label)) error(at + '.label', 'must be a non-empty string');
      if (!isNonEmptyString(node.title)) error(at + '.title', 'must be a non-empty string');
      if (STATUSES.indexOf(node.status) === -1) error(at + '.status', 'must be one of ' + STATUSES.join(', '));
      ['url', 'urlLabel', 'detail'].forEach(function (key) {
        if (node[key] !== undefined && typeof node[key] !== 'string') error(at + '.' + key, 'must be a string when present');
      });
      ['queued', 'optional'].forEach(function (key) {
        if (node[key] !== undefined && typeof node[key] !== 'boolean') error(at + '.' + key, 'must be a boolean when present');
      });
      if (node.queued && node.status !== 'next') error(at + '.queued', 'only applies to status next (up next, not started)');
      if (node.tags !== undefined && (!Array.isArray(node.tags) || !node.tags.every(isNonEmptyString))) {
        error(at + '.tags', 'must be an array of non-empty strings when present');
      }
      if (node.progress !== undefined) {
        var p = node.progress;
        if (!isObject(p) || !isCount(p.done) || !isCount(p.total)) error(at + '.progress', 'must be { done, total } with whole numbers >= 0');
        else if (p.done > p.total) error(at + '.progress', 'done (' + p.done + ') exceeds total (' + p.total + ')');
        else if (p.unit !== undefined && typeof p.unit !== 'string') error(at + '.progress.unit', 'must be a string when present');
      }
    });

    data.nodes.forEach(function (node, i) {
      if (!isObject(node) || !isNonEmptyString(node.id)) return;
      var at = '$.nodes[' + i + '] (' + node.id + ')';
      var spine = SPINE_KINDS.indexOf(node.kind) !== -1;
      if (node.parent !== undefined) {
        if (spine) error(at + '.parent', 'a ' + node.kind + ' is part of the spine and has no parent');
        else if (!byId[node.parent]) error(at + '.parent', 'names ' + JSON.stringify(node.parent) + ', which is not a node id');
        else if (SPINE_KINDS.indexOf(byId[node.parent].kind) === -1) error(at + '.parent', 'must name a milestone or gate, not a ' + byId[node.parent].kind);
      }
      if (node.links !== undefined) {
        if (!Array.isArray(node.links)) error(at + '.links', 'must be an array when present');
        else node.links.forEach(function (link, j) {
          var lat = at + '.links[' + j + ']';
          if (!isObject(link)) { error(lat, 'must be an object'); return; }
          unknownKeys(link, ['to', 'why', 'strong'], lat, error);
          if (!byId[link.to]) error(lat + '.to', 'names ' + JSON.stringify(link.to) + ', which is not a node id');
          if (!isNonEmptyString(link.why)) error(lat + '.why', 'must say why the link exists');
          if (typeof link.strong !== 'boolean') error(lat + '.strong', 'must be true (declared or cited) or false (mentioned)');
        });
      }
      if (node.sections !== undefined) {
        if (!Array.isArray(node.sections)) error(at + '.sections', 'must be an array when present');
        else node.sections.forEach(function (section, j) {
          var sat = at + '.sections[' + j + ']';
          if (!isObject(section)) { error(sat, 'must be an object'); return; }
          unknownKeys(section, ['heading', 'text', 'items', 'refs', 'progress'], sat, error);
          if (!isNonEmptyString(section.heading)) error(sat + '.heading', 'must be a non-empty string');
          var content = ['text', 'items', 'refs', 'progress'].filter(function (key) { return section[key] !== undefined; });
          if (!content.length) error(sat, 'needs at least one of text, items, refs, progress');
          if (section.text !== undefined && typeof section.text !== 'string') error(sat + '.text', 'must be a string');
          if (section.items !== undefined && (!Array.isArray(section.items) || !section.items.every(isNonEmptyString))) error(sat + '.items', 'must be an array of non-empty strings');
          if (section.refs !== undefined) {
            if (!Array.isArray(section.refs)) error(sat + '.refs', 'must be an array of node ids');
            else section.refs.forEach(function (ref) { if (!byId[ref]) error(sat + '.refs', 'names ' + JSON.stringify(ref) + ', which is not a node id'); });
          }
          if (section.progress !== undefined) {
            var sp = section.progress;
            if (!isObject(sp) || !isCount(sp.done) || !isCount(sp.total) || sp.done > sp.total) error(sat + '.progress', 'must be { done, total } with 0 <= done <= total');
          }
        });
      }
    });

    var depNext = {};
    data.edges.forEach(function (edge, i) {
      var at = '$.edges[' + i + ']';
      if (!isObject(edge)) { error(at, 'must be an object'); return; }
      unknownKeys(edge, EDGE_KEYS, at, error);
      if (edge.type === 'child') { error(at + '.type', 'child is not an edge; set parent on the ticket instead'); return; }
      if (EDGE_TYPES.indexOf(edge.type) === -1) error(at + '.type', 'must be one of ' + EDGE_TYPES.join(', '));
      var from = byId[edge.from];
      var to = byId[edge.to];
      if (!from) error(at + '.from', 'names ' + JSON.stringify(edge.from) + ', which is not a node id');
      if (!to) error(at + '.to', 'names ' + JSON.stringify(edge.to) + ', which is not a node id');
      if (!from || !to) return;
      if (edge.from === edge.to) error(at, 'an edge cannot connect a node to itself');
      if (edge.type === 'gate' && to.kind !== 'gate') error(at + '.to', 'a gate edge must end at a gate');
      if (edge.type === 'advisory' && from.kind !== 'gate') error(at + '.from', 'an advisory edge must start at a gate');
      if (edge.type === 'resolves' && from.kind !== 'issue') error(at + '.from', 'a resolves edge must start at an issue');
      if (edge.type === 'dep') (depNext[edge.from] = depNext[edge.from] || []).push(edge.to);
    });

    var cycle = findCycle(depNext);
    if (cycle) error('$.edges', 'dep edges form a cycle: ' + cycle.join(' -> '));

    data.nodes.forEach(function (node) {
      if (!isObject(node) || SPINE_KINDS.indexOf(node.kind) !== -1 || node.parent !== undefined) return;
      var connected = data.edges.some(function (e) { return isObject(e) && (e.from === node.id || e.to === node.id); });
      if (!connected) warn('$.nodes (' + node.id + ')', 'has no parent and no edges, so it is drawn in the unanchored tray');
    });

    return { errors: errors, warnings: warnings };
  }

  function findCycle(next) {
    var state = {};
    var stack = [];
    var found = null;
    function visit(id) {
      if (found) return;
      state[id] = 1;
      stack.push(id);
      (next[id] || []).forEach(function (to) {
        if (found) return;
        if (state[to] === 1) found = stack.slice(stack.indexOf(to)).concat(to);
        else if (!state[to]) visit(to);
      });
      stack.pop();
      state[id] = 2;
    }
    Object.keys(next).forEach(function (id) { if (!state[id]) visit(id); });
    return found;
  }

  var api = {
    validate: validate,
    VERSION: VERSION,
    KINDS: KINDS,
    SPINE_KINDS: SPINE_KINDS,
    STATUSES: STATUSES,
    EDGE_TYPES: EDGE_TYPES,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.taskMapValidate = api;
})(this);
