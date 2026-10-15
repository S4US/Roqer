# Chat grids

The top bar switches between **Grid 1**, **Grid 2**, and so on. **+** creates
an empty grid using the first available number. Each grid keeps its own chat positions and **2**, **4** or
**6** cell layout, selected using the miniature layout icons.
Six cells use three columns on wide windows; narrower windows
use two columns or stack the panels vertically. More rows can be scrolled.
The view button returns to one selected chat and hides the grid tabs and new-grid
button until grid mode is enabled again. Arrow keys, Home and End
switch grids when the tab bar has focus. Closing a grid keeps its chats,
drafts and running tasks; closing the last grid resets it to an empty layout.
Each empty cell offers a custom **Choose a chat** menu from any project or **New chat** in
the selected project. Occupied cells show the chat directly, without an extra
selector bar. Drag a chat's heading onto another cell to move it; two occupied
cells swap chats. A chat appears in only one cell per grid, but can be placed
in several grids. These share one conversation, draft and running task.
Use **Close chat** in a chat's **…** menu to leave its cell in the current grid
empty. Other grids containing that chat are kept. History stays in the sidebar
and a running task continues in the background. Closing the last grid view of
a chat with unsent drafts or attachments requires confirmation before discarding them.
The light/dark theme button appears once in the global tab bar.
Opening a chat from the sidebar puts it in the first empty cell, or
the first cell when the visible layout is full. Changing the layout keeps
assignments outside the smaller layout, and keeps all open drafts and runs.

In grid mode, **Expand chat** in a panel's header makes that chat fill the
workspace. **Return to grid** restores the other panels, including their drafts
and running tasks. Expanding is still grid mode for run concurrency.

Every panel is a complete chat: transcript, composer, attachments, model,
reasoning effort, approval mode, context meter, pending questions and Stop.
Existing chats keep their own draft and run settings when you switch views;
new chats start with the latest defaults. Global theme, bridge address and
Studio status remain shared. Click a panel to make it the selected chat.

Several chats can run at once, including in inactive grids. Grid tabs and the sidebar indicate which chats
are working or waiting for an answer. Approval, question, note and Stop
controls address only their own chat. Closing a chat leaves its run working
in the background; open the chat again from the sidebar to return to it.
Closing a chat with unsent text or files asks before discarding that draft.
Deleting a chat still cancels its run and removes its history.

There is always at most one run per chat. In grid mode, separate chats may
run on the same Studio place, including a place already being used by a run
started outside the grid. They can edit the same scripts: approval policies
and source revision checks still apply, but agents may conflict, so split
their tasks where possible. Switching to single-chat mode does not cancel
existing runs; new starts in that mode are refused until the place is free.
Provider limits and availability still apply.

Chat history remains saved through the normal workspace store. Grids,
their layouts, unsent drafts and each chat's settings are session state; they
are not restored after restarting Roqer. The last selected chat and default
settings are saved as before.
