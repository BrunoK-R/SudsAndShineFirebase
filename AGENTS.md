# Suds Agent Rules

## Ticket Commit Workflow (Required)

After completing each ticket:
1. Stage only ticket-relevant files in git.
2. Post the proposed commit message in chat.
3. Ask for user approval before committing.
4. Commit only after explicit user approval.
5. Proceed to the next ticket only after the commit is done.

## Hosting Deployment Rule (Required)

The website source of truth is `../Website/sudsandshine`. Firebase Hosting serves the built copy in this repo's `public/` directory.

Before any hosting deploy, run `npm run prepare:hosting` from this repo, or use `npm run deploy:hosting`. The Firebase hosting `predeploy` hook also runs that preparation step automatically when `firebase deploy --only hosting` is used from this repo.

Analogy: cook the website fresh in the kitchen (`../Website/sudsandshine`), pack the fresh takeaway box (`public/`), then deliver it with Firebase Hosting.

## Migration Done Criteria (Required)

For any migrated feature, testing is mandatory before marking the ticket as done.
