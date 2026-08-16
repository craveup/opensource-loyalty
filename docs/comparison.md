# Choosing loyalty infrastructure

This comparison uses observable product boundaries, not unverified pricing,
performance, or customer-count claims. Verify every vendor against its current
documentation and contract.

| Question | LIP | Typical commercial loyalty API | Build in-house |
| --- | --- | --- | --- |
| Portable transaction contract | Open spec and conformance suite | Usually provider contract | Team-defined |
| Self-host option | Apache-2.0 reference platform | Varies | Yes |
| Foodservice order shape | Items, modifiers, tenders, taxes, tips, scope | Varies by vendor | Must build |
| Checkout lifecycle | Evaluate, reserve, accrue, capture, reverse, adjust | Verify exact semantics | Must build |
| Retry evidence | Explicit idempotency conflict and ledger | Verify contract | Must design |
| Operations | Reference tools; Cloud is preview | Usually managed | Team owns all |
| Campaign breadth | Implemented core engagement; not positioned as category-leading | Often mature | Must build |
| Migration/adapters | Open planner and certification kit; vendor mappings need partner validation | Often services-led | Must build |

LIP is a strong fit when an ordering platform needs portable, inspectable
checkout correctness and can operate the reference platform or join a managed
pilot. A mature commercial suite may fit better when marketer workflow,
existing certified integrations, contractual global operations, or immediate
enterprise procurement outweigh portability. In-house can fit when loyalty is
a narrow, differentiating capability and the team accepts permanent ownership
of ledger, retries, migrations, fraud, and operations.

Before selecting any provider, run the same paid order, duplicate delivery,
split tender, reservation failure, void, and partial refund through staging;
compare the resulting ledger and recovery path rather than feature-page nouns.
