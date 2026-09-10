# Changelog

Changes are grouped by release. The Unreleased section contains work that has
not been tagged yet.

## [Unreleased]

## [0.2.0] - 2026-09-10

### Added

- Diagnose a frozen renderer in under a second, naming the task space and tab, with a recovery recipe that was tested before being written.
- Cap the default snapshot at 20K characters, cutting at a line boundary and stating how many rows and headings were omitted.
- Suggest the closest role when an unknown role is queried, instead of returning no matches.
- Generate GitHub release notes automatically for version tags.

### Changed

- Take a focus turn per client so a read in one task space no longer blocks readers in another, and release the turn when a client disconnects.
- Select the task space per connection instead of from one global cursor, and route CDP replies to the client that asked for them.
- Answer semantic role queries through `Accessibility.queryAXTree` instead of downloading the whole tree and filtering in Node.
- Emit `loc=` only when a role and name pair is ambiguous, already disambiguated as `>> nth=N`, and build the tree in document order so that index is stable.
- Replace the global `WebSocket` with `ws` and disable permessage-deflate, whose inflate dropped the CDP connection on payloads over ~4MB.
- Collect empty agent task spaces and close agent tabs abandoned for over two hours, never the user's tabs.
- Take a file lock around the daemon spawn so concurrent clients start one daemon instead of racing to bind the socket.
- Report no matches in one form across every path, without internal source, in-page stacks or Node frames.
- Cut cold start from 1.13s to 0.41-0.52s and a warm round from 0.09s to 0.06s.

### Fixed

- Label snapshot rows with the `backendNodeId` the ref map is keyed by, so `@N` resolves to the element it names rather than to whichever node shares its position.
- Refuse a ref whose node left the DOM or whose document was replaced, instead of returning stale data.
- Resolve roles from implicit HTML semantics, so a chained locator finds elements that carry no explicit `role` attribute.
- Click a client rect fragment whose centre hits the element, instead of the centre of the union box, which for an element wrapping across lines falls in the gap between fragments.
- Agree between `isVisible()` and `click()` on zero-height inline-block elements.
- Error on `fill` against a non-fillable element instead of doing nothing.
- Keep ego-browser's own injected source out of `page.url()` timeout errors.
- Clear both the stuck verdict and the tab's slot in its task space on `browser.closeTab`.
- Reuse an existing agent tab by origin before creating a new tab.
- Keep user tabs out of agent task spaces after daemon startup.
- Remove persisted references to tabs that no longer exist.
