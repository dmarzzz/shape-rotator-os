export function createLazyModule(loader) {
  let loadedModule = null;
  let promise = null;
  let loadError = null;

  return {
    peek() { return loadedModule; },
    error() { return loadError; },
    load() {
      if (loadedModule) return Promise.resolve(loadedModule);
      if (!promise) {
        loadError = null;
        promise = loader().then(
          (module) => {
            loadedModule = module;
            return module;
          },
          (error) => {
            promise = null;
            loadError = error;
            throw error;
          },
        );
      }
      return promise;
    },
  };
}
