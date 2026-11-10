# Vita Feed: 3 steps to put it online (GitHub Pages)

1. **Create a repository** on github.com (New repository, set it to Public) and upload everything from this folder,
   including the `.github` folder. If the `.github` folder won't upload, use Add file > Create new file, type
   `.github/workflows/update-feed.yml` as the name and paste in the contents of `update-feed.yml`.
2. **Turn on Pages:** Settings > Pages > Source: "Deploy from branch", Branch: `main`, folder `/ (root)`, Save.
3. **Run the updater once:** Actions tab > "Update Vita feed" > Run workflow.

Your site will be at `https://YOUR-NAME.github.io/REPO-NAME/`. After that it updates itself every 20 minutes.
