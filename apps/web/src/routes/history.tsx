import { createFileRoute } from "@tanstack/react-router";

import { HistoryPage } from "../components/history/HistoryPage";

export const Route = createFileRoute("/history")({
  validateSearch: (search: Record<string, unknown>) => ({
    environment: typeof search.environment === "string" ? search.environment : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  component: HistoryRoute,
});

function HistoryRoute() {
  const { environment, project } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <HistoryPage
      environmentParam={environment ?? null}
      projectParam={project ?? null}
      onScopeChange={(environment, project) => {
        void navigate({
          search: { environment: environment ?? undefined, project: project ?? undefined },
          replace: true,
        });
      }}
    />
  );
}
