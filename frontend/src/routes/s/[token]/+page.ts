export const load = async ({ params }: { params: { token: string } }) => {
  return { token: params.token };
};
