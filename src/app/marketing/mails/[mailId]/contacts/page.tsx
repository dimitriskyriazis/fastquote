import MailContactsClient from "./MailContactsClient";

export default async function Page({ params }: { params: Promise<{ mailId: string }> }) {
  const { mailId } = await params;
  return <MailContactsClient mailId={mailId} />;
}
