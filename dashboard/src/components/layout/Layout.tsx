import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";

export default function Layout() {
  return (
    <div className="min-h-screen bg-[var(--background)]">
      <Sidebar />
      <main className="ml-[240px] p-6">
        <Outlet />
      </main>
    </div>
  );
}
