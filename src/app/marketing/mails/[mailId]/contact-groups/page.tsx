import MailContactGroupsClient from "./MailContactGroupsClient";

export default async function Page({ params }: { params: Promise<{ mailId: string }> }) {
  const { mailId } = await params;
  return <MailContactGroupsClient mailId={mailId} />;
}
