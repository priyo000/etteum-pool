import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/layout/Layout";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Accounts = lazy(() => import("./pages/Accounts"));
const AccountList = lazy(() => import("./pages/AccountList"));
const Models = lazy(() => import("./pages/Models"));
const ApiKey = lazy(() => import("./pages/ApiKey"));
const Requests = lazy(() => import("./pages/Requests"));
const Usage = lazy(() => import("./pages/Usage"));
const Settings = lazy(() => import("./pages/Settings"));
const BotLogs = lazy(() => import("./pages/BotLogs"));

function RouteFallback() {
  return <div className="flex h-64 items-center justify-center text-sm text-[var(--muted-foreground)]">Loading...</div>;
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:provider" element={<AccountList />} />
          <Route path="/models" element={<Models />} />
          <Route path="/api-key" element={<ApiKey />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/bot-logs" element={<BotLogs />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
