This plan fixes the "empty history" bug by creating a unified way for the Web UI to request any file (artifact) from the server.

### Core Definitions
*   **Hydration:** Filling the UI with data from the server after the initial page load.
*   **JSONL:** A file format where each line is a separate JSON object.
*   **Dedup (Deduplication):** Removing duplicate data to prevent the same event from appearing twice.
*   **Idempotency:** A process that can run multiple times safely without changing the final result.

---

### The Logical Flow

#### 1. Server Architecture: The "Artifact" Reader
The server needs a central service to read files from the disk and stream them to the browser.
*   **Create `ProjectArtifacts` service:** A single class that knows where every file (logs, screenshots, session data) lives on the disk.
*   **Make `getProject()` async:** Since the server now reads files from the disk during startup, it must "await" those file reads before sending the initial state to the client.

#### 2. The Communication Protocol (The "Wire")
We need a standard way for the client and server to talk about these files.
*   **Implement Request/Response frames:**
    *   `artifact.fetch`: Client asks for a specific file.
    *   `artifact.chunk`: Server sends a piece of the file.
    *   `artifact.end`: Server signals the file is finished.
    *   `artifact.error`: Server reports a failure.
*   **Use `fetchId`:** Every request gets a unique UUID so the client can track which data belongs to which request.

#### 3. Client Logic: Requesting and Deduping
The Web UI needs to trigger these fetches and ensure the data stays clean.
*   **Build the `useArtifact` hook:**
    *   Check if the data is already "loading" or "loaded" to avoid duplicate requests.
    *   Generate a `fetchId`.
    *   Send the `artifact.fetch` command over the WebSocket.
    *   Clear the "inflight" status once the file ends or fails.
*   **Implement the Deduping Logic:**
    *   Create a unique key for every event: `SessionID + Timestamp + Content Hash`.
    *   Store these keys in a `Set`.
    *   When a new event arrives (live or replayed), check the `Set`; if the key exists, ignore the event.
*   **Lazy Sorting:** Because replayed events might arrive after live ones, sort the events by their timestamp right before rendering them on screen.

#### 4. Loading Strategy: Inline vs. Lazy
To keep the app fast, we split data into "small/fast" and "large/slow" categories.
*   **Cold-start Inlining (Small data):**
    *   Send the last 500 notifications immediately.
    *   Send small text summaries (under 32KB) during the initial handshake.
*   **Lazy Fetching (Large data):**
    *   Detailed logs, full session histories, and screenshots are only fetched when the user actually clicks on them.

---

### Implementation Steps

*   **Step 1 & 2: Server Foundation**
    *   Create the `ProjectArtifacts` class.
    *   Add the WebSocket command handlers for fetching chunks.
*   **Step 3: Fix the Primary Bug**
    *   Add the `useArtifact` hook to the session log column.
    *   Events now stream from the disk into the UI.
*   **Step 4 & 5: Metadata and UI Polish**
    *   Update the server to send small snippets of data (notifications/summaries) during startup.
    *   Update the UI to display these snippets and add "Load More" buttons for truncated data.
*   **Step 6 & 7: Final Coverage and Cleanup**
    *   Add support for all remaining file types (screenshots, instruction files).
    *   Delete the old, broken `session.replay` code from the codebase.

---

### End-to-End Verification
1.  **Open a historical session:** The UI should immediately request events and render them instead of showing "No events yet."
2.  **Verify Deduping:** Refreshing the page or navigating back and forth should not cause duplicate logs to appear.
3.  **Check Live Race:** Start a live process while viewing a history log; events should appear in the correct chronological order.

Was the explanation of the "Deduping" logic clear enough for your implementation?