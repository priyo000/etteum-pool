import { Routes, Route } from "react-router-dom";
import Layout from "./components/layout/Layout";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import AccountList from "./pages/AccountList";
import Models from "./pages/Models";
import ApiKey from "./pages/ApiKey";
import Requests from "./pages/Requests";
import Usage from "./pages/Usage";
import Settings from "./pages/Settings";
import BotLogs from "./pages/BotLogs";

export default function App() {
  return (
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
  );
}
