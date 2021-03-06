import {
  ActionCreatorWithPayload,
  AnyAction,
  Middleware,
} from '@reduxjs/toolkit';
import { FeatureProps, ScriptMethodDef } from './json';
import { Database } from './database';
import { BaseFlowNode } from './flowTypes';
import { AdvancedFlowState } from './iterator';
import { Variable, VariableStore } from './variables';

export interface ExtensionTypes {}
type ApplicationState = ExtensionTypes extends { ApplicationState: unknown }
  ? ExtensionTypes['ApplicationState']
  : unknown;

// Generator which queues script reducers until finally returning a variable value
type ScriptGenerator = Generator<AnyAction, Variable | void, undefined>;

// Used internally. This is the signature used by the actual Articy Expresso scripts
type ScriptFunctionInternal = (...args: Variable[]) => Variable | void;

// Signature of script functions you can register. They must either return a value OR generate script reducers
export type ScriptFunction = (
  state: Readonly<ApplicationState> | undefined,
  db: Database,
  ...args: Variable[]
) => Variable | void | ScriptGenerator;

// List of registered functions by name
const registeredFunctions: Record<string, ScriptFunction> = {};

// State context (only set while root reducer is running)
let state: Readonly<ApplicationState> | undefined = undefined;

// Queued actions
let actionQueue: AnyAction[] | undefined = undefined;

function queueGeneratedActions(
  generator: ScriptGenerator,
  shadowing: boolean
): Variable | void {
  // Iterate the results
  let result = generator.next();
  while (!result.done) {
    // Don't queue in shadow mode
    if (!shadowing && actionQueue) {
      // Queue for post-update
      actionQueue.push(result.value);
    }

    // Move on to the next result
    result = generator.next();
  }

  // Final result is the return value
  return result.value;
}

/**
 * Gives articy script function handlers access to the Redux store and the ability to return Redux actions to queue
 */
type createMiddlewareFunction = (
  finalizeAction?: ActionCreatorWithPayload<AnyAction>
) => Middleware;
export const createScriptDispatchMiddleware: createMiddlewareFunction = finalizeAction => storeApi => next => action => {
  // Prime us to queue
  let queue: AnyAction[] = [];
  actionQueue = queue;

  // Set state
  state = storeApi.getState();

  // Execute action normally
  const result = next(action);

  // Clear queue and state
  actionQueue = undefined;
  state = undefined;

  // Dispatch appropriate actions
  for (const action of queue) {
    storeApi.dispatch(action);
  }

  // If we dispatched anything, then dispatch a finalize action
  if (queue.length > 0 && finalizeAction) {
    storeApi.dispatch(finalizeAction(action));
  }

  // Return result
  return result;
};

// Wraps a ScriptFunction and returns a function suitable for Articy's Expresso scripts.
// Automatically handles the function potentially returning reducers to be queued at the end of the state update.
function wrapScriptFunction(
  func: ScriptFunction,
  state: Readonly<ApplicationState> | undefined,
  db: Database,
  shadowing: boolean
): ScriptFunctionInternal {
  return (...args) => {
    // Execute the underlying method
    const returnValue = func(state, db, ...args);

    // Check if the result is an iterator. If so, this is a generator.
    if (typeof returnValue === 'object') {
      return queueGeneratedActions(returnValue, shadowing);
    }

    return returnValue;
  };
}

/**
 * Registers a Javascript function so it can be called from Articy
 * @param name Function name (used in Articy)
 * @param func Function
 */
export function RegisterScriptFunction(
  name: string,
  func: ScriptFunction
): void {
  registeredFunctions[name] = func;
}

/**
 * Clears all registered functions
 */
export function ClearRegisteredScriptFunctions(): void {
  for (const key of Object.keys(registeredFunctions)) {
    delete registeredFunctions[key];
  }
}

/** Checks if a script method is properly registered. Logs an error if not. */
export function VerifyRegisteredScriptMethod(method: ScriptMethodDef): boolean {
  if (!(method.Name in registeredFunctions)) {
    console.error(
      `Script method ${method.Name} is used in this Articy Database but is not registered in code!`
    );
    return false;
  }

  return true;
}

type FeatureExecutionHandler<Feature extends FeatureProps = FeatureProps> = (
  db: Database,
  feature: Feature,
  node: BaseFlowNode,
  state: AdvancedFlowState
) => Variable | void | ScriptGenerator;
const featureHandlers: Map<string, FeatureExecutionHandler[]> = new Map();

/**
 * Registers a handler function called whenever a node with a given feature is executed in flow.
 * @param name Feature name
 * @param handler Handler to register
 */
export function RegisterFeatureExecutionHandler<Feature extends FeatureProps>(
  name: string,
  handler: FeatureExecutionHandler<Feature>
): void {
  if (!featureHandlers.has(name)) {
    featureHandlers.set(name, [handler as FeatureExecutionHandler]);
  } else {
    featureHandlers.get(name)?.push(handler as FeatureExecutionHandler);
  }
}

/**
 * Calls all registered feature handlers for a node
 * @param node Flow node
 */
export function OnNodeExecution(
  node: BaseFlowNode,
  state: AdvancedFlowState
): void {
  if (!node.template) {
    return;
  }

  // Iterate all its features
  for (const key of Object.keys(node.template ?? {})) {
    // Check if we have a handler for that feature
    const handlers = featureHandlers.get(key);
    if (!handlers) {
      return;
    }

    // If so, run handlers
    const feature = node.template[key];
    for (const handler of handlers) {
      const returnValue = handler(node.db, feature, node, state);
      if (typeof returnValue === 'object') {
        queueGeneratedActions(returnValue, false);
      }
    }
  }
}

/**
 * Clears all registered feature handlers
 */
export function ClearRegisteredFeatureHandlers(): void {
  featureHandlers.clear();
}

/**
 * Runs a condition or instruction script
 * @param script Script to run
 * @param variables Global variable store
 * @param db Database
 * @param returns Is this script expected to return a boolean?
 */
export function runScript(
  script: string | undefined,
  variables: VariableStore,
  db: Database,
  returns: boolean,
  shadowing: boolean
): boolean {
  // No script? Return true.
  if (!script || script === '') {
    return true;
  }

  // Get variable names
  const names = Array.from(Object.keys(variables));

  // Get functio names
  const funcNames = Array.from(Object.keys(registeredFunctions));

  // Create a function which takes all the variable sets its arguments
  // eslint-disable-next-line no-new-func
  const func = new Function(
    'window',
    ...names,
    ...funcNames,
    `"use strict"; ${returns ? 'return' : ''} ${script}`
  );

  // Call the function with the variable sets
  const result = func.call(
    undefined,
    undefined,
    ...names.map(n => variables[n]),
    ...funcNames.map(f =>
      wrapScriptFunction(registeredFunctions[f], state, db, shadowing)
    )
  );

  // Check if it's true
  return result === true;
}
