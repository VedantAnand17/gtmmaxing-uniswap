import { ToolPage, TOOL_ROUTES } from "../features/tools/ToolPage";
import { reportBrowserError } from "../lib/errorReporting";
import { createRootRoute, createRoute, createRouter, useLocation } from "@tanstack/react-router";
import { AppShell, ProtectedHistoryRoute, ProtectedUsageRoute } from "./AppShell";
import { FeatureWaitlistPage } from "../features/waitlist/FeatureWaitlistPage";
import { AddToAgentPage } from "../features/agents/AddToAgentPage";
import { ApiKeysPage } from "../features/agents/ApiKeysPage";
import { ConnectPage } from "../features/agents/ConnectPage";
import { ApprovePage } from "../features/agents/ApprovePage";

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: ProtectedHistoryRoute,
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: ProtectedUsageRoute,
});
const featureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/features/$feature",
  component: FeatureRoute,
});

/** The connector consent screen an AI app's sign-in request lands on. */
const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect",
  component: ConnectPage,
});
/** World ID Agent Pass: the owner approves or denies an agent request past its credit cap. */
const approveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approve",
  component: ApprovePage,
});
const addToAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/add-to-agent",
  component: AddToAgentPage,
});

function FeatureRoute() {
  const { feature } = featureRoute.useParams();
  const runId = new URLSearchParams(useLocation().searchStr).get("run") ?? undefined;
  const tool = TOOL_ROUTES[feature];
  if (tool) return <ToolPage key={`${feature}:${runId ?? ""}`} tool={tool} runId={runId} />;
  return feature === "api-keys" ? <ApiKeysPage key={feature} /> : <FeatureWaitlistPage key={feature} featureSlug={feature} />;
}

const routeTree = rootRoute.addChildren([indexRoute, historyRoute, usageRoute, featureRoute, connectRoute, approveRoute, addToAgentRoute]);

export const router = createRouter({ routeTree, defaultOnCatch: (error) => reportBrowserError("render", error) });
