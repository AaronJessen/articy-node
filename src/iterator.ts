import { ArticyObjectProps, Id } from './json';
import { Database } from './database';
import { BaseFlowNode } from './flowTypes';
import { ArticyObjectCreator } from './object';
import { OnNodeExecution } from './script';
import { ArticyObject } from './types';
import { VariableStore } from './variables';

/**
 * Keeps track of the number of times a node has been visited
 */
export interface VisitCounts {
  [name: string]: number;
}

/**
 * Keeps track of the last turn index a node was visited
 */
export interface VisitIndicies {
  [name: string]: number;
}

/**
 * Keeps track of visited nodes.
 */
export interface VisitSet {
  counts: VisitCounts;
  indicies: VisitIndicies;
}

/**
 * Represents a basic iterator in the flow.
 */
export interface FlowState {
  id: Id | null;
  last: Id | null;
  variables: VariableStore;

  /** If true, we're in shadow mode. Don't commit any permenant changes to game state. */
  shadowing?: boolean;
}

/**
 * Represents a branch in the flow.
 */
export class FlowBranch {
  /**
   * Branch index. Used when calling the continue function in iteration.
   */
  public readonly index: number;

  /**
   * Full branch path from current flow node to the terminal node.
   */
  public readonly path: BaseFlowNode[];

  constructor(index = -1, path: BaseFlowNode[] = []) {
    this.index = index;
    this.path = path;
  }

  /**
   * Returns the terminal node
   */
  destination(): BaseFlowNode {
    return this.path[this.path.length - 1];
  }

  /**
   * Checks if the terminal node is of a given type
   * @param type Type to check (can be string type name or type class)
   */
  destinationIs(type: ArticyObjectCreator | string): boolean {
    if (typeof type === 'string') {
      return this.destination().is(type);
    }
    return this.destination() instanceof type;
  }

  /**
   * Returns the terminal node as the specified type or undefined if it doesn't match.
   * Can combine class type with string type. Will only return non-undefined if it matches both.
   * @param type Flow node type
   * @param typeString Type string
   */
  destinationAs<ObjectType>(
    type: ArticyObjectCreator<ObjectType>,
    typeString?: string
  ): ObjectType | undefined {
    const dest = this.destination();

    // Make sure it matches the return type
    if (!(dest instanceof type)) {
      return undefined;
    }

    // Make sure it matches the string type
    if (typeString && !dest.is(typeString)) {
      return undefined;
    }

    // Correc type. Return.
    return dest;
  }

  /**
   * Like destinationAs but checks along the path for the first matching node
   * @param type Type to return
   * @param typeString Type string
   */
  pathHas<ObjectType>(
    type: ArticyObjectCreator<ObjectType>,
    typeString: string
  ): ObjectType | undefined {
    // Go through path
    for (let i = 0; i < this.path.length; i++) {
      const item = this.path[i];

      // Check if it's the right type
      if (!(item instanceof type)) {
        continue;
      }

      // Check type string
      if (typeString && !item.is(typeString)) {
        continue;
      }

      // Return item
      return item;
    }

    // Fail
    return undefined;
  }
}

/**
 * Advanced flow iterator. Contains not just a current position in the flow but a visit set and current branches
 */
export interface AdvancedFlowState extends FlowState {
  /**
   * Cache of branches available at this juncture
   */
  branches: FlowBranch[];

  /**
   * All nodes visited so far.
   */
  visits: VisitSet;

  /**
   * Turn counter. Not sure what it represents but it goes up.
   */
  turn: number;
}

/**
 * Empty advanced flow iterator. Use this to begin iteration.
 */
export const NullAdvancedFlowState: AdvancedFlowState = {
  id: null,
  last: null,
  variables: {},
  visits: { counts: {}, indicies: {} },
  branches: [],
  turn: 0,
};

/**
 * Custom handling for iteration stops
 */
export enum CustomStopType {
  /**
   * Normal stop. Stop here and return a new branch.
   */
  NormalStop = 'NORMAL_STOP',

  /**
   * Stop and continue.
   * Return a new branch with this node as the terminal but continue making new branches past it.
   */
  StopAndContinue = 'STOP_AND_CONTINUE',

  /**
   * Continue. Ignores stop. Continue iteration looking for terminals.
   */
  Continue = 'CONTINUE',
}

/**
 * Configuration for advanced flow state iteration
 */
export interface AdvancedIterationConfig {
  /**
   * These node types are considered "terminal".
   * Iteration will stop at them and return a new branch.
   */
  stopAtTypes: string[];

  /**
   * Called on notes that match stopAtTypes. Customizes how the stop is handled.
   */
  customStopHandler?: (
    node: BaseFlowNode,
    visits: VisitSet
  ) => CustomStopType | void;
}

/**
 * From a flow state, find all immediate (valid) child flow nodes
 * @param db Database
 * @param state Current flow state
 * @param node Current node (If you already have it. Avoids unnecessary lookups)
 */
export function getFlowStateChildren(
  db: Database,
  state: FlowState,
  node?: BaseFlowNode
): BaseFlowNode[] {
  if (!state.id) {
    return [];
  }

  // Get node to access
  node = node ?? db.getObject(state.id, BaseFlowNode);
  if (!node) {
    return [];
  }

  // Grab children
  const children: BaseFlowNode[] = [];
  const numChildren = node.numBranches(
    state.variables,
    state.last,
    state.shadowing ?? false
  );
  for (let i = 0; i < numChildren; i++) {
    const child = node.next(
      state.variables,
      i,
      state.last,
      state.shadowing ?? false
    );
    if (child) {
      children.push(child);
    }
  }

  return children;
}

type BasicFlowIterationResult = [FlowState, BaseFlowNode | undefined];
type AdvancedIterationResult = [AdvancedFlowState, BaseFlowNode | undefined];

/**
 * Advances a flow state one node down a branch.
 * @param db Database
 * @param state Current flow state
 * @param branchIndex Branch index to follow (-1 to only follow if there is exactly one path)
 * @returns The new flow state and the new current node (used to avoid unnecessary lookups)
 */
export function basicNextFlowState(
  db: Database,
  state: FlowState,
  branchIndex: number
): BasicFlowIterationResult {
  // Nowhere to go. We have no ID.
  if (!state.id) {
    return [state, undefined];
  }

  // Get current node
  const node = db.getObject(state.id, BaseFlowNode);

  // Find the next node
  const next = node?.next(
    state.variables,
    branchIndex,
    state.last,
    state.shadowing ?? false
  );

  // Nowhere to go.
  if (!next) {
    return [
      { id: null, last: null, variables: {}, shadowing: state.shadowing },
      undefined,
    ];
  }

  // Create new state
  return [
    {
      id: next.properties.Id,
      last: state.id,
      variables: state.variables,
      shadowing: state.shadowing,
    },
    next,
  ];
}

function shouldStopAt(
  node: ArticyObject<ArticyObjectProps>,
  stopAtTypes: string[]
) {
  if (stopAtTypes.filter(t => node.is(t)).length > 0) {
    return true;
  }
  return false;
}

/**
 * Advances from the starting ID to a desired stop at node (or not if we are already at a stop at node)
 * @param db Database
 * @param start Starting ID
 * @param config Advancement options
 */
export function advancedStartupFlowState(
  db: Database,
  start: Id,
  config: AdvancedIterationConfig
): AdvancedIterationResult {
  // Create initial state
  let initial: AdvancedFlowState = {
    id: start,
    last: null,
    branches: [],
    variables: db.newVariableStore(),
    visits: { counts: {}, indicies: {} },
    turn: 0,
  };
  initial = refreshBranches(db, initial, config);

  // Get start node
  const node = db.getObject(start, BaseFlowNode);
  if (!node) {
    return [NullAdvancedFlowState, undefined];
  }

  // Check if it's a valid starting point
  if (shouldStopAt(node, config.stopAtTypes)) {
    return [initial, node];
  }

  // Otherwise, advance
  return advancedNextFlowState(db, initial, config, 0);
}

/**
 * Advances a flow state until it hits a node that matches the search criteria.
 * @param db Database
 * @param state Current flow state
 * @param branchIndex Branch index to follow
 * @returns A new advanced flow state with a list of available branches. Also returns the current node to avoid unncessary lookups.
 */
export function advancedNextFlowState(
  db: Database,
  state: AdvancedFlowState,
  config: AdvancedIterationConfig,
  branchIndex: number
): AdvancedIterationResult {
  // Check if its in bounds
  if (branchIndex < 0 || branchIndex >= state.branches.length) {
    return [state, undefined];
  }
  if (!state.id) {
    return [state, undefined];
  }

  // Get branch to follow
  const branch = state.branches.find(x => x.index === branchIndex);
  if (!branch) {
    return [state, undefined];
  }

  let vars = state.variables;
  let hasCloned = false;

  const visits: VisitSet = {
    indicies: { ...state.visits.indicies },
    counts: { ...state.visits.counts },
  };

  // Execute each stage in the path
  for (const step of branch.path) {
    // Clone variable store if we're going to change it
    if (!hasCloned && step.needsShadow()) {
      hasCloned = true;
      vars = cloneVariableStore(vars);
    }

    // Execute node
    step.execute(vars);

    // Call any registered handlers
    // TODO: Do we need to pass a more up to date state??
    OnNodeExecution(step, state);

    // Mark as visited
    let count = visits.counts[step.properties.Id] ?? 0;
    count++;
    visits.counts[step.properties.Id] = count;

    // Set current turn
    visits.indicies[step.properties.Id] = state.turn;
  }

  // Move to end
  let last = db.getObject(state.id, BaseFlowNode);
  if (branch.path.length > 1) {
    last = branch.path[branch.path.length - 2];
  }
  const curr = branch.path[branch.path.length - 1];
  const newFlowState = {
    // New node ID
    id: curr.properties.Id,

    // Id of the last node we were on
    last: last?.properties.Id,

    // Empty branch list - will be refreshed after
    branches: [],

    // Copy over variables
    variables: vars,

    // Visits
    visits: visits,

    // Next turn index
    turn: state.turn + 1,
  };

  // Return state with branches
  return [refreshBranches(db, newFlowState, config), curr];
}

interface Visit_Limitation {
  Only_Once: boolean;
}

export function collectBranches(
  db: Database,
  iter: FlowState,
  config: AdvancedIterationConfig,
  visits: VisitSet,
  branch?: FlowBranch,
  index = 0,
  direction = -1,
  node?: BaseFlowNode
): FlowBranch[] {
  // No valid ID? Return nothing.
  if (!iter.id) {
    return [];
  }

  // Get the node at this flow state
  node = node ?? db.getObject(iter.id, BaseFlowNode);
  if (!node) {
    return [];
  }

  // Make sure branch object exists
  if (!branch) {
    branch = new FlowBranch(index);
  }

  // Get number of branches
  let branches = node.numBranches(
    iter.variables,
    iter.last,
    iter.shadowing ?? false
  );

  // Travel this route as long as there is only one child
  while (branches === 1 || direction >= 0) {
    // Check for shadowing
    if (node.needsShadow()) {
      // Create a cloned variable store to use from here on out
      iter.variables = cloneVariableStore(iter.variables);
    }

    // Move to that child
    [iter, node] = basicNextFlowState(db, iter, direction);
    direction = -1;

    // If no node exists, this is a dead end
    if (!node) {
      // No return since we didn't hit a valid end point
      return [];
    }

    // Check if this is a visit limited node
    const limit_feature = node.template?.Visit_Limitation as
      | Visit_Limitation
      | undefined;
    if (limit_feature && limit_feature.Only_Once) {
      // Kill the branch if we've already been visited
      if ((visits.counts[node.properties.Id] ?? 0) > 0) {
        return [];
      }
    }

    // Otherwise, add to our current branch
    branch.path.push(node);

    // Check if we're ready to stop
    if (shouldStopAt(node, config.stopAtTypes)) {
      // Check if there's custom stop logic for this node
      if (config.customStopHandler) {
        const behaviour = config.customStopHandler(node, visits);

        // Default behaviour. Return branch and stop.
        if (
          behaviour === CustomStopType.NormalStop ||
          behaviour === undefined
        ) {
          return [branch];
        } else if (behaviour === CustomStopType.StopAndContinue) {
          // We want to return a branch at the current position plus whatever branches follow us
          const forked = new FlowBranch(index + 1, [...branch.path]);
          return [
            branch,
            ...collectBranches(
              db,
              iter,
              config,
              visits,
              forked,
              index + 1,
              0,
              node
            ),
          ];
        } else if (behaviour === CustomStopType.Continue) {
          // Continue. Do nothing
        } else {
          // Unexpected type... stop?
          console.log(
            `Unexpected custom stop behaviour found: ${behaviour}. Unsure what to do.... Stopping here.`
          );
          return [branch];
        }
      } else {
        // No custom stop behaviour. Use default stop and return branch.
        return [branch];
      }
    }

    // Continue
    branches = node.numBranches(
      iter.variables,
      iter.last,
      iter.shadowing ?? false
    );
  }

  // If we're here, we've reached a fork
  let result: FlowBranch[] = [];
  for (let i = 0; i < branches; i++) {
    // Duplicate branch
    const forked = new FlowBranch(index, [...branch.path]);

    // Go!
    result = [
      ...result,
      ...collectBranches(db, iter, config, visits, forked, index, i, node),
    ];

    // Update index
    if (result.length > 0) {
      index = result[result.length - 1].index + 1;
    }
  }

  return result;
}

function cloneVariableStore(vars: VariableStore): VariableStore {
  return JSON.parse(JSON.stringify(vars));
}

/**
 * Updates the available branches in an advanced flow state
 * @param db Database
 * @param state Advanced flow state
 * @param config Advanced iteration config settings
 */
export function refreshBranches(
  db: Database,
  state: AdvancedFlowState,
  config: AdvancedIterationConfig
): AdvancedFlowState {
  const result = { ...state };
  const vars = state.variables;
  result.branches = collectBranches(
    db,
    { ...state, shadowing: true },
    config,
    state.visits
  );
  result.variables = vars;
  return result;
}
