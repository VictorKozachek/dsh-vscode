/**
 * Резолвер для тестов, которые импортируют TS-модули с относительными
 * импортами без расширения (Node type-stripping такие сам не находит).
 * Расширение `.ts` подставляется только после неудачи стандартного резолва.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const suffix of ['.ts', '.js']) {
        try {
          return await nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // пробуем следующий вариант
        }
      }
    }
    throw error;
  }
}
