export function createCrmClient(): {
  lookupAccount(input: unknown): Promise<{ id: string; input: unknown }>;
} {
  return {
    async lookupAccount(input: unknown) {
      return { id: 'acct-fixture-001', input };
    },
  };
}
