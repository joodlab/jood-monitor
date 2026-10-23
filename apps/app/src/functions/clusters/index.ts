import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getClusterStatus,
  getEvents,
  getHistory,
  getSnapshot,
  recoverEnrollment,
  registerCluster,
  registerWorkspace,
  updateProfile,
  workspaces,
} from "../../actions/clusters";
import { getSeriesHistory } from "../../actions/clusters/series";
import { operatorMiddleware } from "../../middlewares/operator";
import { serverTimingMiddleware } from "../../middlewares/server-timing";
import {
  clusterSchema,
  clusterStatusSchema,
  eventsSchema,
  historySchema,
  idSchema,
  profileSchema,
  seriesHistorySchema,
  snapshotSchema,
  workspaceSchema,
} from "../../schemas/clusters";

export const getSnapshotFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware, serverTimingMiddleware])
  .validator(snapshotSchema)
  .handler(({ context, data }) =>
    getSnapshot(context.env, data, context.timing)
  );
export const getHistoryFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(historySchema)
  .handler(({ context, data }) => getHistory(context.env, data));
// Several series for a few Nodes or Pods in one bounded raw read.
export const getSeriesHistoryFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware, serverTimingMiddleware])
  .validator(seriesHistorySchema)
  .handler(({ context, data }) =>
    getSeriesHistory(context.env, data, context.timing)
  );
export const getEventsFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware, serverTimingMiddleware])
  .validator(eventsSchema)
  .handler(({ context, data }) => getEvents(context.env, data, context.timing));
export const getClusterStatusFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(clusterStatusSchema)
  .handler(({ context, data }) => getClusterStatus(context.env, data));
export const getWorkspacesFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(({ context }) => workspaces(context.env));
export const registerClusterFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(clusterSchema)
  .handler(({ context, data }) => registerCluster(context.env, data));
export const recoverEnrollmentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(idSchema)
  .handler(({ context, data }) => recoverEnrollment(context.env, data));
export const updateProfileFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(z.strictObject({ clusterId: idSchema, profile: profileSchema }))
  .handler(({ context, data }) =>
    updateProfile(context.env, data.clusterId, data.profile)
  );
export const createWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(workspaceSchema)
  .handler(({ context, data }) => registerWorkspace(context.env, data));
