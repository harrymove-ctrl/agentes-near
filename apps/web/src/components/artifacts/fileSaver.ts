/** Saves a URL as a file (an `<a download>` click). Swappable for tests. */
export const fileSaver = {
  save(url: string, name: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  },
};
