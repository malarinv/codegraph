/**
 * Graph Module
 *
 * Provides graph traversal and query functionality for the code knowledge graph.
 */

export { GraphTraverser } from './traversal';
export { GraphQueryManager } from './queries';
export {
  buildTypeHierarchy,
  canHaveHierarchy,
  countImplementers,
  DISPATCH_MIN_IMPLEMENTERS,
  HIERARCHY_EDGE_KINDS,
  HIERARCHY_KINDS,
  MAX_DESCENDANTS,
} from './type-hierarchy';
export type {
  HierarchyEntry,
  HierarchyRelation,
  OverrideMatch,
  TypeHierarchy,
} from './type-hierarchy';
